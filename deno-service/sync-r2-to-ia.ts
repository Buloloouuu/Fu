/**
 * Futaba archiver — R2-to-IA fallback sync sweep (GitHub Actions edition)
 *
 * PURPOSE: unchanged from the Deno Deploy version — walk every "folder"
 * that actually exists in the R2 bucket, pull ONE archived thread object
 * from each folder per pass, and keep cycling through folders (1 per
 * folder per round) until either:
 *   - SAMPLE_LIMIT threads total have been collected, or
 *   - every folder has been fully drained
 * whichever comes first. Every thread in the sample is then uploaded to
 * Internet Archive (same IAS3 flow as before), and — if the upload
 * succeeds — deleted from R2.
 *
 * WHY THIS EXISTS AT ALL, POST IA-FIRST CHANGE:
 * archive-thread.ts now uploads straight to Internet Archive per-thread
 * and only touches R2 when that IA PUT fails (outage, rate limit, bad
 * creds, oversized item, etc). This script is what drains whatever ends
 * up sitting in R2 because of those fallbacks — it's the safety net, not
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
 * R2 access is unchanged: no native R2 binding is available outside
 * Cloudflare Workers, so this talks to the same R2 bucket over R2's
 * S3-compatible API, signing every request with AWS Signature V4 via
 * `aws4fetch` — identical to how archive-thread.ts's R2 fallback path
 * authenticates.
 *
 * Required environment variables (set as GitHub Actions repo/environment
 * secrets — see .github/workflows/sync-r2-to-ia.yml):
 *   R2_ACCOUNT_ID              - Cloudflare account ID that owns the R2 bucket
 *   R2_ACCESS_KEY_ID           - R2 API token access key ID
 *   R2_SECRET_ACCESS_KEY       - R2 API token secret access key
 *   R2_BUCKET_NAME             - name of the R2 bucket (same bucket archive-thread.ts falls back to)
 *   IA_ACCESS_KEY / IA_SECRET_KEY - Internet Archive S3-style keys (required;
 *                                    if missing every item in this run fails)
 *
 * Optional:
 *   SAMPLE_LIMIT               - total threads to draw across all folders per
 *                                 run (default 45, matching original behavior)
 *   DELETE_FROM_R2_AFTER_SYNC  - "false" to keep the R2 copy after a
 *                                 successful IA upload (default: delete)
 *   IA_IDENTIFIER / IA_COLLECTION / IA_MEDIATYPE / IA_ITEM_TITLE /
 *   IA_ITEM_DESCRIPTION        - same meaning as before / as archive-thread.ts
 *
 * Run locally: deno run -A deno-service/sync-r2-to-ia.ts
 */

import { AwsClient } from "npm:aws4fetch@1.0.20";

interface Env {
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
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

function loadEnv(): Env {
  const req = (name: string): string => {
    const v = Deno.env.get(name);
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
  };
  const opt = (name: string): string | undefined => Deno.env.get(name) ?? undefined;

  return {
    R2_ACCOUNT_ID: req("R2_ACCOUNT_ID"),
    R2_ACCESS_KEY_ID: req("R2_ACCESS_KEY_ID"),
    R2_SECRET_ACCESS_KEY: req("R2_SECRET_ACCESS_KEY"),
    R2_BUCKET_NAME: req("R2_BUCKET_NAME"),
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
}

// ---------- R2 access via S3-signed requests ----------

interface R2ObjectSummary {
  key: string;
  size: number;
}

function r2Client(env: Env): { client: AwsClient; endpoint: string } {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  return { client, endpoint };
}

/** Minimal ListObjectsV2 XML parsing — avoids pulling in a full XML parser
 *  for what's a predictable, well-formed AWS response shape. */
function parseListObjectsXml(xml: string): {
  objects: R2ObjectSummary[];
  isTruncated: boolean;
  nextToken?: string;
} {
  const objects: R2ObjectSummary[] = [];
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

async function listAllObjects(env: Env): Promise<R2ObjectSummary[]> {
  const { client, endpoint } = r2Client(env);
  const all: R2ObjectSummary[] = [];
  let token: string | undefined;

  do {
    const url = new URL(`${endpoint}/${env.R2_BUCKET_NAME}`);
    url.searchParams.set("list-type", "2");
    if (token) url.searchParams.set("continuation-token", token);

    const res = await client.fetch(url.toString());
    if (!res.ok) {
      throw new Error(`R2 ListObjectsV2 failed: ${res.status} ${await res.text()}`);
    }
    const xml = await res.text();
    const parsed = parseListObjectsXml(xml);
    all.push(...parsed.objects);
    token = parsed.isTruncated ? parsed.nextToken : undefined;
  } while (token);

  return all;
}

async function getObjectBuffer(env: Env, key: string): Promise<ArrayBuffer | null> {
  const { client, endpoint } = r2Client(env);
  const url = `${endpoint}/${env.R2_BUCKET_NAME}/${encodeR2Key(key)}`;
  const res = await client.fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 GetObject failed for ${key}: ${res.status} ${await res.text()}`);
  return await res.arrayBuffer();
}

async function deleteObject(env: Env, key: string): Promise<void> {
  const { client, endpoint } = r2Client(env);
  const url = `${endpoint}/${env.R2_BUCKET_NAME}/${encodeR2Key(key)}`;
  const res = await client.fetch(url, { method: "DELETE" });
  if (!res.ok && res.status !== 204) {
    throw new Error(`R2 DeleteObject failed for ${key}: ${res.status} ${await res.text()}`);
  }
}

/** Path-encode a key for use in a URL, preserving "/" separators. */
function encodeR2Key(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

// ---------- Folder discovery (replaces hardcoded board config) ----------

function discoverFolders(objects: R2ObjectSummary[]): Map<string, R2ObjectSummary[]> {
  const folders = new Map<string, R2ObjectSummary[]>();
  for (const obj of objects) {
    if (obj.key.startsWith("_state/") || obj.key.includes("/_state/")) continue;
    const slash = obj.key.lastIndexOf("/");
    if (slash === -1) continue; // no folder, ignore stray root-level objects
    const folder = obj.key.slice(0, slash + 1);
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder)!.push(obj);
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
    `Archived Futaba Channel threads from ${folder}, each saved as a ZIP (index.html + assets/). Uploaded automatically by the R2-to-IA fallback sync sweep.`;

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
    return { ok: false, reason: `IA upload request failed: ${e}` };
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    return { ok: false, status: res.status, reason: bodyText.slice(0, 500), identifier, filename };
  }

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
  items: R2ObjectSummary[];
  index: number;
}

function sampleRoundRobin(
  folders: Map<string, R2ObjectSummary[]>,
  limit: number
): { folder: string; obj: R2ObjectSummary }[] {
  const queues: Queue[] = Array.from(folders.entries()).map(([folder, items]) => ({
    folder,
    items,
    index: 0,
  }));

  const selected: { folder: string; obj: R2ObjectSummary }[] = [];
  let madeProgressThisRound = true;

  while (selected.length < limit && madeProgressThisRound) {
    madeProgressThisRound = false;
    for (const q of queues) {
      if (selected.length >= limit) break;
      if (q.index >= q.items.length) continue;
      const obj = q.items[q.index++];
      selected.push({ folder: q.folder, obj });
      madeProgressThisRound = true;
    }
  }

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

  const results: SyncResultEntry[] = [];
  for (const { folder, obj } of selected) {
    const threadId = obj.key.split("/").pop()!.replace(/\.(?:mht|zip)$/i, "");
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
      }
    } catch (e) {
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
  const env = loadEnv();
  const summary = await runSampleAndSync(env);

  console.log(JSON.stringify(summary, null, 2));

  if (summary.sampled === 0) {
    console.log("Nothing to sync — R2 fallback bucket is empty (as expected when IA-first uploads are healthy).");
  } else if (summary.failed > 0) {
    console.error(`${summary.failed}/${summary.sampled} item(s) failed to sync — see results above.`);
  }

  // Non-zero exit on any failure so the Actions run itself is visibly red
  // in the GitHub UI, same convention as archive-thread.ts.
  Deno.exit(summary.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`Unhandled error in main(): ${e}`);
  Deno.exit(1);
});
