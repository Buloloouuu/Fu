/**
 * Futaba archiver — B2-to-IA fallback sync sweep (GitHub Actions edition)
 *
 * PURPOSE: unchanged — walk every "folder" that actually exists in the
 * B2 bucket, pull ONE archived thread object from each folder per pass,
 * and keep cycling through folders (1 per folder per round) until either:
 *   - SAMPLE_LIMIT threads total have been collected, or
 *   - every folder has been fully drained
 * whichever comes first. Every thread in the sample is then uploaded to
 * Internet Archive (same IAS3 flow as before), and — if the upload
 * succeeds — deleted from B2.
 *
 * WHY THIS EXISTS AT ALL, POST IA-FIRST CHANGE:
 * archive-thread.ts now uploads straight to Internet Archive per-thread
 * and only touches B2 when that IA PUT fails (outage, rate limit, bad
 * creds, oversized item, etc). This script is what drains whatever ends
 * up sitting in B2 because of those fallbacks — it's the safety net, not
 * the primary path anymore. Folders are still discovered dynamically
 * (grouping object keys by their directory prefix), so nothing needs to
 * be hardcoded as fallback volume shifts over time.
 *
 * ARCHITECTURE CHANGE FROM THE DENO DEPLOY VERSION:
 * This used to be a `Deno.serve` HTTP server (triggered by a GET to
 * /sample-sync, protected by AUTH_TOKEN) with an optional `Deno.cron`
 * schedule running alongside it. Both of those existed only to give the
 * script a trigger; GitHub Actions already provides both triggers
 * natively (`schedule:` and `workflow_dispatch:` in the companion
 * workflow file), so this is now a plain one-shot CLI script: run once,
 * print a JSON summary, exit 0 on full success or 1 if anything failed,
 * same convention archive-thread.ts uses so a bad sweep shows red in the
 * Actions UI.
 *
 * STORAGE BACKEND CHANGE: this script (like archive-thread.ts and
 * catalog.ts) originally targeted Cloudflare R2 (accountId-scoped
 * endpoint, R2_* env vars, region "auto"). It now targets Backblaze B2
 * instead — same shape of S3-compatible API (ListObjectsV2/GetObject/
 * DeleteObject signed with AWS Signature V4 via `aws4fetch`, since
 * there's no native binding for either provider outside Cloudflare
 * Workers), just a different endpoint host
 * (`s3.<region>.backblazeb2.com` instead of an account-ID-scoped R2
 * host) and a real region string instead of "auto". Nothing about the
 * discovery/sampling/upload/delete *logic* below changed, only
 * b2Client()/b2ObjectUrl() and the env var names.
 *
 * Required environment variables (set as GitHub Actions repo/environment
 * secrets — see .github/workflows/sync-r2-to-ia.yml):
 *   B2_KEY_ID              - Backblaze B2 Application Key ID
 *   B2_APPLICATION_KEY     - Backblaze B2 Application Key secret
 *   B2_BUCKET_NAME         - name of the B2 bucket (same bucket archive-thread.ts falls back to)
 *   B2_REGION              - the bucket's region segment, e.g. "us-west-004"
 *                             (taken from its S3 endpoint
 *                             s3.<region>.backblazeb2.com — pass the
 *                             region alone, not the full endpoint; B2
 *                             does not accept "auto" the way R2 did)
 *   IA_ACCESS_KEY / IA_SECRET_KEY - Internet Archive S3-style keys (required;
 *                                    if missing every item in this run fails)
 *   REMOVED: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME.
 *
 * Optional:
 *   SAMPLE_LIMIT               - total threads to draw across all folders per
 *                                 run (default 45, matching original behavior)
 *   DELETE_FROM_R2_AFTER_SYNC  - "false" to keep the B2 copy after a
 *                                 successful IA upload (default: delete).
 *                                 Env var name kept as-is (not renamed to
 *                                 DELETE_FROM_B2_AFTER_SYNC) so existing
 *                                 repo/environment variable configuration
 *                                 doesn't need to be touched.
 *   IA_IDENTIFIER / IA_COLLECTION / IA_MEDIATYPE / IA_ITEM_TITLE /
 *   IA_ITEM_DESCRIPTION        - same meaning as before / as archive-thread.ts
 *
 * Run locally: deno run -A deno-service/sync-r2-to-ia.ts
 */

import { AwsClient } from "npm:aws4fetch@1.0.20";

interface Env {
  B2_KEY_ID: string;
  B2_APPLICATION_KEY: string;
  B2_BUCKET_NAME: string;
  B2_REGION: string;
  SAMPLE_LIMIT?: string;
  DELETE_FROM_R2_AFTER_SYNC?: string;
  IA_ACCESS_KEY?: string;
  IA_SECRET_KEY?: string;
  IA_IDENTIFIER?: string;
  IA_COLLECTION?: string;
  IA_MEDIATYPE?: string;
  IA_ITEM_TITLE?: string;
  IA_ITEM_DESCRIPTION?: string;
}

// ---------- Logging helpers ----------
//
// Plain console.log/error works fine in the Actions log viewer, but a
// bare JSON dump at the very end makes it hard to tell *where* a run
// went sideways without expanding the whole step. These helpers add a
// timestamp + level prefix and get sprinkled through every phase below
// (discovery, sampling, per-item upload/delete) so a scan of the raw
// log is enough to see progress and pinpoint failures without waiting
// for the final summary.

function ts(): string {
  return new Date().toISOString();
}

function log(msg: string): void {
  console.log(`[${ts()}] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[${ts()}] WARN ${msg}`);
}

function logError(msg: string): void {
  console.error(`[${ts()}] ERROR ${msg}`);
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let val = n / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

function loadEnv(): Env {
  const req = (name: string): string => {
    const v = Deno.env.get(name);
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
  };
  const opt = (name: string): string | undefined => Deno.env.get(name) ?? undefined;

  const env: Env = {
    B2_KEY_ID: req("B2_KEY_ID"),
    B2_APPLICATION_KEY: req("B2_APPLICATION_KEY"),
    B2_BUCKET_NAME: req("B2_BUCKET_NAME"),
    B2_REGION: req("B2_REGION"),
    SAMPLE_LIMIT: opt("SAMPLE_LIMIT"),
    DELETE_FROM_R2_AFTER_SYNC: opt("DELETE_FROM_R2_AFTER_SYNC"),
    IA_ACCESS_KEY: opt("IA_ACCESS_KEY"),
    IA_SECRET_KEY: opt("IA_SECRET_KEY"),
    IA_IDENTIFIER: opt("IA_IDENTIFIER"),
    IA_COLLECTION: opt("IA_COLLECTION"),
    IA_MEDIATYPE: opt("IA_MEDIATYPE"),
    IA_ITEM_TITLE: opt("IA_ITEM_TITLE"),
    IA_ITEM_DESCRIPTION: opt("IA_ITEM_DESCRIPTION"),
  };

  log(
    `Config loaded — bucket=${env.B2_BUCKET_NAME} region=${env.B2_REGION} ` +
      `sampleLimitOverride=${env.SAMPLE_LIMIT ?? "(unset, will default to 45)"} ` +
      `deleteAfterSync=${env.DELETE_FROM_R2_AFTER_SYNC !== "false"} ` +
      `iaCredsPresent=${Boolean(env.IA_ACCESS_KEY && env.IA_SECRET_KEY)} ` +
      `iaIdentifierOverride=${env.IA_IDENTIFIER ?? "(unset, derived per-folder)"}`
  );
  if (!env.IA_ACCESS_KEY || !env.IA_SECRET_KEY) {
    warn("IA_ACCESS_KEY/IA_SECRET_KEY not set — every item this run will fail at upload time.");
  }

  return env;
}

// ---------- B2 access via S3-signed requests ----------

interface B2ObjectSummary {
  key: string;
  size: number;
}

function b2Client(env: Env): { client: AwsClient; endpoint: string } {
  const client = new AwsClient({
    accessKeyId: env.B2_KEY_ID,
    secretAccessKey: env.B2_APPLICATION_KEY,
    service: "s3",
    region: env.B2_REGION,
  });
  const endpoint = `https://s3.${env.B2_REGION}.backblazeb2.com`;
  return { client, endpoint };
}

/** Minimal ListObjectsV2 XML parsing — avoids pulling in a full XML parser
 *  for what's a predictable, well-formed AWS response shape. */
function parseListObjectsXml(xml: string): {
  objects: B2ObjectSummary[];
  isTruncated: boolean;
  nextToken?: string;
} {
  const objects: B2ObjectSummary[] = [];
  const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m: RegExpExecArray | null;
  while ((m = contentsRe.exec(xml))) {
    const block = m[1];
    const key = block.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] ?? "";
    const size = Number(block.match(/<Size>([\s\S]*?)<\/Size>/)?.[1] ?? "0");
    if (key) objects.push({ key: decodeXmlEntities(key), size });
  }
  const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const nextToken = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1];
  return { objects, isTruncated, nextToken: nextToken ? decodeXmlEntities(nextToken) : undefined };
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function listAllObjects(env: Env): Promise<B2ObjectSummary[]> {
  const { client, endpoint } = b2Client(env);
  const all: B2ObjectSummary[] = [];
  let token: string | undefined;
  let page = 0;

  log(`Listing objects in bucket "${env.B2_BUCKET_NAME}"...`);
  do {
    page++;
    const url = new URL(`${endpoint}/${env.B2_BUCKET_NAME}`);
    url.searchParams.set("list-type", "2");
    if (token) url.searchParams.set("continuation-token", token);

    const res = await client.fetch(url.toString());
    if (!res.ok) {
      const body = await res.text();
      logError(`B2 ListObjectsV2 failed on page ${page}: ${res.status} ${body.slice(0, 300)}`);
      throw new Error(`B2 ListObjectsV2 failed: ${res.status} ${body}`);
    }
    const xml = await res.text();
    const parsed = parseListObjectsXml(xml);
    all.push(...parsed.objects);
    log(
      `  page ${page}: +${parsed.objects.length} object(s) (running total ${all.length})` +
        (parsed.isTruncated ? " — more pages remain" : "")
    );
    token = parsed.isTruncated ? parsed.nextToken : undefined;
  } while (token);

  const totalBytes = all.reduce((sum, o) => sum + o.size, 0);
  log(`Listing complete — ${all.length} object(s) across ${page} page(s), ${fmtBytes(totalBytes)} total.`);
  return all;
}

async function getObjectBuffer(env: Env, key: string): Promise<ArrayBuffer | null> {
  const { client, endpoint } = b2Client(env);
  const url = `${endpoint}/${env.B2_BUCKET_NAME}/${encodeB2Key(key)}`;
  const res = await client.fetch(url);
  if (res.status === 404) {
    warn(`GetObject 404 for "${key}" — object disappeared between listing and read.`);
    return null;
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`B2 GetObject failed for ${key}: ${res.status} ${body}`);
  }
  return await res.arrayBuffer();
}

async function deleteObject(env: Env, key: string): Promise<void> {
  const { client, endpoint } = b2Client(env);
  const url = `${endpoint}/${env.B2_BUCKET_NAME}/${encodeB2Key(key)}`;
  const res = await client.fetch(url, { method: "DELETE" });
  if (!res.ok && res.status !== 204) {
    const body = await res.text();
    throw new Error(`B2 DeleteObject failed for ${key}: ${res.status} ${body}`);
  }
  log(`  deleted "${key}" from B2 after successful IA upload.`);
}

/** Path-encode a key for use in a URL, preserving "/" separators. */
function encodeB2Key(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

// ---------- Folder discovery (replaces hardcoded board config) ----------

function discoverFolders(objects: B2ObjectSummary[]): Map<string, B2ObjectSummary[]> {
  const folders = new Map<string, B2ObjectSummary[]>();
  let ignoredState = 0;
  let ignoredRootLevel = 0;

  for (const obj of objects) {
    if (obj.key.startsWith("_state/") || obj.key.includes("/_state/")) {
      ignoredState++;
      continue;
    }
    const slash = obj.key.lastIndexOf("/");
    if (slash === -1) {
      ignoredRootLevel++;
      continue; // no folder, ignore stray root-level objects
    }
    const folder = obj.key.slice(0, slash + 1);
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder)!.push(obj);
  }

  log(
    `Discovered ${folders.size} folder(s) from ${objects.length} object(s) ` +
      `(ignored ${ignoredState} state file(s), ${ignoredRootLevel} root-level stray object(s)).`
  );
  const preview = Array.from(folders.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10)
    .map(([folder, items]) => `${folder} (${items.length})`)
    .join(", ");
  if (folders.size > 0) {
    log(`  top folders by pending count: ${preview}${folders.size > 10 ? ", ..." : ""}`);
  }

  return folders;
}

// ---------- Internet Archive (IAS3) upload — unchanged flow, mirrors
// archive-thread.ts's uploadToInternetArchive() exactly so identifier
// derivation and metadata headers behave the same regardless of which
// script actually pushed a given thread ----------

function sanitizeIaIdentifierPart(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

function iaHeaderValue(str: string): string {
  if (/^[\x20-\x7E]*$/.test(str)) return str;
  return `uri(${encodeURIComponent(str)})`;
}

function iaItemIdentifier(env: Env, folder: string): string {
  const configured = env.IA_IDENTIFIER && sanitizeIaIdentifierPart(env.IA_IDENTIFIER);
  if (configured) return configured.slice(0, 100).replace(/-+$/, "");
  const slug = sanitizeIaIdentifierPart(folder);
  return `futaba-archive-${slug}`.slice(0, 100).replace(/-+$/, "");
}

function iaFilenameFor(folder: string, threadId: string): string {
  const slug = sanitizeIaIdentifierPart(folder);
  return `${slug}_${threadId}.zip`;
}

interface IaUploadResult {
  ok: boolean;
  status?: number;
  reason?: string;
  identifier?: string;
  filename?: string;
  detailsUrl?: string;
}

async function uploadToInternetArchive(
  env: Env,
  folder: string,
  threadId: string,
  buffer: ArrayBuffer
): Promise<IaUploadResult> {
  if (!env.IA_ACCESS_KEY || !env.IA_SECRET_KEY) {
    return { ok: false, reason: "IA_ACCESS_KEY/IA_SECRET_KEY not configured" };
  }
  const identifier = iaItemIdentifier(env, folder);
  const filename = iaFilenameFor(folder, threadId);
  const uploadUrl = `https://s3.us.archive.org/${identifier}/${filename}`;

  const title = env.IA_ITEM_TITLE || `Futaba thread archive (${folder})`;
  const description =
    env.IA_ITEM_DESCRIPTION ||
    `Archived Futaba Channel threads from ${folder}, each saved as a ZIP (index.html + assets/). Uploaded automatically by the B2-to-IA fallback sync sweep.`;

  log(`  uploading to IA: item="${identifier}" file="${filename}" size=${fmtBytes(buffer.byteLength)}`);

  let res: Response;
  try {
    res = await fetch(uploadUrl, {
      method: "PUT",
      redirect: "follow",
      headers: {
        Authorization: `LOW ${env.IA_ACCESS_KEY}:${env.IA_SECRET_KEY}`,
        "x-amz-auto-make-bucket": "1",
        "x-archive-ignore-preexisting-bucket": "1",
        "x-archive-meta-collection": env.IA_COLLECTION || "opensource",
        "x-archive-meta-mediatype": env.IA_MEDIATYPE || "web",
        "x-archive-meta-title": iaHeaderValue(title),
        "x-archive-meta-description": iaHeaderValue(description),
        "x-archive-meta-subject": "futaba;imageboard;archive",
        "x-archive-queue-derive": "0",
        "Content-Type": "application/zip",
      },
      body: buffer,
    });
  } catch (e) {
    logError(`  IA upload request failed for "${filename}": ${e}`);
    return { ok: false, reason: `IA upload request failed: ${e}` };
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    logError(`  IA upload rejected for "${filename}": ${res.status} ${bodyText.slice(0, 300)}`);
    return { ok: false, status: res.status, reason: bodyText.slice(0, 500), identifier, filename };
  }

  log(`  IA upload OK: https://archive.org/details/${identifier} (file: ${filename})`);
  return {
    ok: true,
    status: res.status,
    identifier,
    filename,
    detailsUrl: `https://archive.org/details/${identifier}`,
  };
}

// ---------- Round-robin sampling (unchanged logic) ----------

interface Queue {
  folder: string;
  items: B2ObjectSummary[];
  index: number;
}

function sampleRoundRobin(
  folders: Map<string, B2ObjectSummary[]>,
  limit: number
): { folder: string; obj: B2ObjectSummary }[] {
  const queues: Queue[] = Array.from(folders.entries()).map(([folder, items]) => ({
    folder,
    items,
    index: 0,
  }));

  const selected: { folder: string; obj: B2ObjectSummary }[] = [];
  let madeProgressThisRound = true;
  let round = 0;

  while (selected.length < limit && madeProgressThisRound) {
    round++;
    madeProgressThisRound = false;
    for (const q of queues) {
      if (selected.length >= limit) break;
      if (q.index >= q.items.length) continue;
      const obj = q.items[q.index++];
      selected.push({ folder: q.folder, obj });
      madeProgressThisRound = true;
    }
  }

  const drainedFolders = queues.filter((q) => q.index >= q.items.length).length;
  log(
    `Sampled ${selected.length}/${limit} thread(s) across ${round} round-robin round(s) ` +
      `(${drainedFolders}/${queues.length} folder(s) fully drained this pass).`
  );

  return selected;
}

interface SyncResultEntry extends IaUploadResult {
  key: string;
  folder?: string;
}

interface SyncSummary {
  ok: boolean;
  foldersDiscovered: number;
  limit: number;
  sampled: number;
  uploaded: number;
  failed: number;
  results: SyncResultEntry[];
}

async function runSampleAndSync(env: Env): Promise<SyncSummary> {
  // NOTE: preserving the original default of 45 (the doc comment in the
  // very first version of this script claimed 30, but the code always
  // used `|| 45` — keeping the real behavior, not the stale comment).
  const limit = parseInt(env.SAMPLE_LIMIT ?? "", 10) || 45;
  const deleteAfterSync = env.DELETE_FROM_R2_AFTER_SYNC !== "false";

  const allObjects = await listAllObjects(env);
  const folders = discoverFolders(allObjects);
  const selected = sampleRoundRobin(folders, limit);

  if (selected.length === 0) {
    log("No objects to sync this run.");
  }

  const results: SyncResultEntry[] = [];
  let processed = 0;
  for (const { folder, obj } of selected) {
    processed++;
    const threadId = obj.key.split("/").pop()!.replace(/\.(?:mht|zip)$/i, "");
    log(`[${processed}/${selected.length}] "${obj.key}" (folder=${folder}, ${fmtBytes(obj.size)})`);
    try {
      const buffer = await getObjectBuffer(env, obj.key);
      if (!buffer) {
        results.push({ key: obj.key, ok: false, reason: "object disappeared before read" });
        continue;
      }
      const ia = await uploadToInternetArchive(env, folder, threadId, buffer);
      results.push({ key: obj.key, folder, ...ia });

      if (ia.ok && deleteAfterSync) {
        await deleteObject(env, obj.key);
      } else if (ia.ok && !deleteAfterSync) {
        log(`  DELETE_FROM_R2_AFTER_SYNC=false — leaving "${obj.key}" in B2.`);
      } else {
        warn(`  skipping delete for "${obj.key}" — IA upload did not succeed.`);
      }
    } catch (e) {
      logError(`  unhandled error processing "${obj.key}": ${e}`);
      results.push({ key: obj.key, ok: false, reason: String(e) });
    }
  }

  const failed = results.filter((r) => !r.ok).length;

  return {
    ok: failed === 0,
    foldersDiscovered: folders.size,
    limit,
    sampled: selected.length,
    uploaded: results.filter((r) => r.ok).length,
    failed,
    results,
  };
}

// ---------- Entry point ----------

async function main() {
  const startedAt = Date.now();
  log("=== Sync B2 fallback -> Internet Archive: starting ===");

  const env = loadEnv();
  const summary = await runSampleAndSync(env);

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(
    `=== Sweep finished in ${elapsedSec}s — ` +
      `${summary.uploaded} uploaded, ${summary.failed} failed, ` +
      `${summary.sampled} sampled from ${summary.foldersDiscovered} folder(s) (limit=${summary.limit}) ===`
  );

  if (summary.failed > 0) {
    log("Failure detail:");
    for (const r of summary.results.filter((r) => !r.ok)) {
      logError(`  "${r.key}" (folder=${r.folder ?? "?"}): ${r.reason ?? "unknown error"}`);
    }
  }

  console.log(JSON.stringify(summary, null, 2));

  if (summary.sampled === 0) {
    log("Nothing to sync — B2 fallback bucket is empty (as expected when IA-first uploads are healthy).");
  } else if (summary.failed > 0) {
    logError(`${summary.failed}/${summary.sampled} item(s) failed to sync — see failure detail above.`);
  } else {
    log(`All ${summary.uploaded} sampled item(s) synced successfully.`);
  }

  // Non-zero exit on any failure so the Actions run itself is visibly red
  // in the GitHub UI, same convention as archive-thread.ts.
  Deno.exit(summary.ok ? 0 : 1);
}

main().catch((e) => {
  logError(`Unhandled error in main(): ${e}`);
  Deno.exit(1);
});
