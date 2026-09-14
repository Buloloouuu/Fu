/**
 * Futaba archiver — GitHub Releases-to-IA fallback sync sweep (GitHub Actions edition)
 *
 * PURPOSE: unchanged from the B2/R2 versions — walk every "folder" that
 * actually exists in storage, pull ONE archived thread object from each
 * folder per pass, and keep cycling through folders (1 per folder per
 * round) until either:
 *   - SAMPLE_LIMIT threads total have been collected, or
 *   - every folder has been fully drained
 * whichever comes first. Every thread in the sample is then uploaded to
 * Internet Archive (same IAS3 flow as before), and — if the upload
 * succeeds — deleted from storage.
 *
 * STORAGE BACKEND CHANGE: this project has dropped Cloudflare (and R2)
 * entirely — see deno-service/archive-thread.ts and deno-service/
 * catalog.ts, both of which now target GitHub instead. This script
 * follows the same move: "folders" are now GitHub Releases (one release
 * per board, tagged with that board's slug — see boardSlug() in
 * catalog.ts/archive-thread.ts) and "objects" are that release's assets
 * (one per thread, named "<threadId>.zip"). Listing/reading/deleting go
 * through the GitHub REST API with a bearer token instead of an
 * S3-signed request, so the aws4fetch dependency is gone too — no
 * signing library needed for plain bearer-token REST calls.
 *
 * OVERLAP NOTE: deno-service/catalog.ts's own syncToInternetArchive()
 * (reachable via GET /sync-ia, optionally on a SYNC_CRON schedule)
 * already does this same job against the same Release assets, just with
 * a simpler board-by-board sampling order instead of this script's fair
 * round-robin-across-folders sampling. Running both is safe — a
 * double-delete on an already-uploaded asset just 404s, which both
 * scripts tolerate — but if you don't need the fairness guarantee this
 * script's round-robin gives you, the Deno service's built-in sweep may
 * be all you need and this workflow can be deleted.
 *
 * WHY A SEPARATE FALLBACK SWEEP EXISTS AT ALL:
 * archive-thread.ts uploads straight to a GitHub Release per thread as
 * its normal path (see that file) — there's no IA-first-with-fallback
 * step built into it currently. This sweep instead treats "whatever is
 * sitting in Release assets" as the source of truth to drain into IA on
 * its own schedule, independent of the archive path. If you want a true
 * IA-first-with-Release-fallback flow (only landing in a Release asset
 * when an IA PUT fails at archive time), that logic would need to move
 * into archive-thread.ts itself — this script doesn't assume that, it
 * just syncs whatever Release assets currently exist.
 *
 * ARCHITECTURE: plain one-shot CLI script, same convention as
 * archive-thread.ts — run once, print a JSON summary, exit 0 on full
 * success or 1 if anything failed, so a bad sweep shows red in the
 * Actions UI. GitHub Actions' own `schedule:` / `workflow_dispatch:`
 * triggers (see the companion workflow file) are what fire it; nothing
 * in-process needs its own scheduler.
 *
 * Required environment variables (set as GitHub Actions repo/environment
 * secrets — see .github/workflows/sync-releases-to-ia.yml):
 *   GITHUB_TOKEN            - needs `contents: write` on the target repo
 *                             (read is enough to list/download, write is
 *                             needed to delete an asset after a
 *                             successful IA upload). The workflow's own
 *                             auto-issued token works fine here as long
 *                             as the job sets `permissions: contents:
 *                             write` — no separate PAT required.
 *   GITHUB_OWNER            - repo owner/org
 *   GITHUB_REPO             - repo name
 *   IA_ACCESS_KEY / IA_SECRET_KEY - Internet Archive S3-style keys (required;
 *                                    if missing every item in this run fails)
 *   REMOVED: B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME, B2_REGION,
 *            R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 *            R2_BUCKET_NAME.
 *
 * Optional:
 *   SAMPLE_LIMIT               - total threads to draw across all folders per
 *                                 run (default 45, matching original behavior)
 *   DELETE_FROM_R2_AFTER_SYNC  - "false" to keep the Release asset after a
 *                                 successful IA upload (default: delete).
 *                                 Env var name kept as-is (not renamed) for
 *                                 continuity with catalog.ts's own IA sync,
 *                                 which keeps the same name for the same
 *                                 reason — existing repo/environment
 *                                 variable configuration doesn't need to
 *                                 be touched.
 *   IA_IDENTIFIER / IA_COLLECTION / IA_MEDIATYPE / IA_ITEM_TITLE /
 *   IA_ITEM_DESCRIPTION        - same meaning as before / as archive-thread.ts
 *
 * Run locally: deno run -A deno-service/sync-releases-to-ia.ts
 */

interface Env {
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
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
    GITHUB_TOKEN: req("GITHUB_TOKEN"),
    GITHUB_OWNER: req("GITHUB_OWNER"),
    GITHUB_REPO: req("GITHUB_REPO"),
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
    `Config loaded — repo=${env.GITHUB_OWNER}/${env.GITHUB_REPO} ` +
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

// ---------- GitHub Releases access (replaces B2/R2 S3-signed requests) ----------

const GH_API = "https://api.github.com";

interface ReleaseAssetSummary {
  key: string; // "<tag>/<assetName>" — kept as "key" so downstream logging/summary shapes match the old B2/R2 version
  releaseId: number;
  assetId: number;
  size: number;
}

function ghHeaders(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...extra,
  };
}

interface GhReleaseSummary {
  id: number;
  tag_name: string;
}

async function listAllReleases(env: Env): Promise<GhReleaseSummary[]> {
  const all: GhReleaseSummary[] = [];
  let page = 1;
  log(`Listing releases in ${env.GITHUB_OWNER}/${env.GITHUB_REPO}...`);
  for (;;) {
    const res = await fetch(
      `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases?per_page=100&page=${page}`,
      { headers: ghHeaders(env) }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logError(`list releases failed on page ${page}: ${res.status} ${body.slice(0, 300)}`);
      throw new Error(`GitHub list releases failed: ${res.status} ${body}`);
    }
    const batch: GhReleaseSummary[] = await res.json();
    all.push(...batch);
    log(`  page ${page}: +${batch.length} release(s) (running total ${all.length})`);
    if (batch.length < 100) break;
    page++;
  }
  log(`Release listing complete — ${all.length} release(s) found.`);
  return all;
}

async function listAllObjects(env: Env): Promise<ReleaseAssetSummary[]> {
  const releases = await listAllReleases(env);
  const all: ReleaseAssetSummary[] = [];

  for (const release of releases) {
    let page = 1;
    for (;;) {
      const res = await fetch(
        `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/${release.id}/assets?per_page=100&page=${page}`,
        { headers: ghHeaders(env) }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        logError(`list assets for release "${release.tag_name}" failed on page ${page}: ${res.status} ${body.slice(0, 300)}`);
        throw new Error(`GitHub list assets failed: ${res.status} ${body}`);
      }
      const batch: Array<{ id: number; name: string; size: number }> = await res.json();
      for (const asset of batch) {
        all.push({
          key: `${release.tag_name}/${asset.name}`,
          releaseId: release.id,
          assetId: asset.id,
          size: asset.size,
        });
      }
      if (batch.length < 100) break;
      page++;
    }
  }

  const totalBytes = all.reduce((sum, o) => sum + o.size, 0);
  log(`Listing complete — ${all.length} asset(s) across ${releases.length} release(s), ${fmtBytes(totalBytes)} total.`);
  return all;
}

async function getObjectBuffer(env: Env, obj: ReleaseAssetSummary): Promise<ArrayBuffer | null> {
  const res = await fetch(`${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/assets/${obj.assetId}`, {
    headers: ghHeaders(env, { Accept: "application/octet-stream" }),
  });
  if (res.status === 404) {
    warn(`GetAsset 404 for "${obj.key}" — object disappeared between listing and read.`);
    return null;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub asset download failed for ${obj.key}: ${res.status} ${body}`);
  }
  return await res.arrayBuffer();
}

async function deleteObject(env: Env, obj: ReleaseAssetSummary): Promise<void> {
  const res = await fetch(`${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/assets/${obj.assetId}`, {
    method: "DELETE",
    headers: ghHeaders(env),
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub DeleteAsset failed for ${obj.key}: ${res.status} ${body}`);
  }
  log(`  deleted "${obj.key}" from Releases after successful IA upload.`);
}

// ---------- Folder discovery (a "folder" is now a release, keyed by its tag) ----------

function discoverFolders(objects: ReleaseAssetSummary[]): Map<string, ReleaseAssetSummary[]> {
  const folders = new Map<string, ReleaseAssetSummary[]>();

  for (const obj of objects) {
    const slash = obj.key.lastIndexOf("/");
    // Every key here is "<tag>/<assetName>" by construction (see
    // listAllObjects), so this should never actually miss — kept as a
    // defensive fallback rather than an assumption.
    const folder = slash === -1 ? obj.key : obj.key.slice(0, slash + 1);
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder)!.push(obj);
  }

  log(`Discovered ${folders.size} folder(s) (release(s)) from ${objects.length} asset(s).`);
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
    `Archived Futaba Channel threads from ${folder}, each saved as a ZIP (index.html + assets/). Uploaded automatically by the Releases-to-IA fallback sync sweep.`;

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
  items: ReleaseAssetSummary[];
  index: number;
}

function sampleRoundRobin(
  folders: Map<string, ReleaseAssetSummary[]>,
  limit: number
): { folder: string; obj: ReleaseAssetSummary }[] {
  const queues: Queue[] = Array.from(folders.entries()).map(([folder, items]) => ({
    folder,
    items,
    index: 0,
  }));

  const selected: { folder: string; obj: ReleaseAssetSummary }[] = [];
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
  // NOTE: preserving the original default of 45 (an early doc comment on
  // this script's predecessor claimed 30, but the code always used
  // `|| 45` — keeping the real behavior, not the stale comment).
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
    const assetName = obj.key.slice(obj.key.lastIndexOf("/") + 1);
    const threadId = assetName.replace(/\.zip$/i, "");
    log(`[${processed}/${selected.length}] "${obj.key}" (folder=${folder}, ${fmtBytes(obj.size)})`);
    try {
      const buffer = await getObjectBuffer(env, obj);
      if (!buffer) {
        results.push({ key: obj.key, ok: false, reason: "object disappeared before read" });
        continue;
      }
      const ia = await uploadToInternetArchive(env, folder, threadId, buffer);
      results.push({ key: obj.key, folder, ...ia });

      if (ia.ok && deleteAfterSync) {
        await deleteObject(env, obj);
      } else if (ia.ok && !deleteAfterSync) {
        log(`  DELETE_FROM_R2_AFTER_SYNC=false — leaving "${obj.key}" in Releases.`);
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
  log("=== Sync GitHub Releases fallback -> Internet Archive: starting ===");

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
    log("Nothing to sync — Releases fallback is empty (as expected when the primary path is healthy).");
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
