/**
 * Futaba archiver — TeraBox-to-IA fallback sync sweep (GitHub Actions edition)
 *
 * PURPOSE: walk every board "folder" that actually has archived threads
 * in TeraBox, pull ONE archived thread per folder per round, and keep
 * cycling (1 per folder per round) until either SAMPLE_LIMIT threads
 * total have been collected, or every folder is fully drained. Every
 * thread in the sample is then uploaded to Internet Archive (IAS3), and
 * — if the upload succeeds — deleted from TeraBox.
 *
 * STORAGE BACKEND: TeraBox now, not GitHub Releases (and not B2/R2
 * before that). "Folders" are board directory prefixes under
 * TERABOX_ROOT_DIR (see boards.ts/terabox-store.ts); "objects" are the
 * ZIP files directly under each board's prefix, one per thread.
 *
 * This is now the ONLY sync sweep in this project — catalog.ts's own IA
 * sync was removed when the Cloudflare Worker was retired, so there's no
 * second process to worry about double-processing with.
 *
 * ARCHITECTURE: plain one-shot CLI script — run once, print a JSON
 * summary, exit 0 on full success or 1 if anything failed, so a bad
 * sweep shows red in the Actions UI. The companion workflow's
 * `schedule:` / `workflow_dispatch:` triggers are what fire it; nothing
 * in-process needs its own scheduler.
 *
 * Required environment variables:
 *   TERABOX_NDUS               - TeraBox session cookie (required; if
 *                                 missing every item in this run fails)
 *   IA_ACCESS_KEY / IA_SECRET_KEY - Internet Archive S3-style keys (required)
 *
 * Optional:
 *   TERABOX_ROOT_DIR           - defaults to /futaba-archive
 *   SAMPLE_LIMIT                - total threads to draw across all folders
 *                                 per run (default 45)
 *   DELETE_FROM_R2_AFTER_SYNC   - "false" to keep the object after a
 *                                 successful IA upload (default: delete).
 *                                 Name kept as-is for continuity with
 *                                 earlier revisions of this project.
 *   IA_IDENTIFIER / IA_COLLECTION / IA_MEDIATYPE / IA_ITEM_TITLE /
 *   IA_ITEM_DESCRIPTION        - same meaning as in archive-thread.ts
 *
 * Run locally: deno run -A deno-service/sync-terabox-to-ia.ts
 */

import { listDir, getObject, deleteObject, pathFor } from "./terabox-store.ts";
import { getBoards, type Board } from "./boards.ts";

interface Env {
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
  const opt = (name: string): string | undefined => Deno.env.get(name) ?? undefined;

  const env: Env = {
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

  if (!Deno.env.get("TERABOX_NDUS")) {
    warn("TERABOX_NDUS not set — every item this run will fail at read/delete time.");
  }
  if (!env.IA_ACCESS_KEY || !env.IA_SECRET_KEY) {
    warn("IA_ACCESS_KEY/IA_SECRET_KEY not set — every item this run will fail at upload time.");
  }

  log(
    `Config loaded — sampleLimitOverride=${env.SAMPLE_LIMIT ?? "(unset, will default to 45)"} ` +
      `deleteAfterSync=${env.DELETE_FROM_R2_AFTER_SYNC !== "false"} ` +
      `iaCredsPresent=${Boolean(env.IA_ACCESS_KEY && env.IA_SECRET_KEY)} ` +
      `iaIdentifierOverride=${env.IA_IDENTIFIER ?? "(unset, derived per-folder)"}`
  );

  return env;
}

// ---------- TeraBox object listing ----------

interface ObjectSummary {
  key: string; // "<board slug>/<threadId>.zip" — mirrors the old B2/R2/Releases "key" shape for downstream logging
  path: string; // absolute TeraBox path
  folder: string; // board prefix this object lives under
  size: number;
}

function boardPrefix(board: Board): string {
  return pathFor(`${board.host}${board.path}`.replace(/\/+/g, "/"));
}

async function listAllObjects(): Promise<ObjectSummary[]> {
  const boards = getBoards();
  const all: ObjectSummary[] = [];

  log(`Listing archived objects across ${boards.length} board(s)...`);
  for (const board of boards) {
    const folder = boardPrefix(board);
    const items = await listDir(folder);
    for (const item of items) {
      if (item.path.includes("/_state/")) continue; // skip sort-cycle / archived / pending state blobs
      const relKey = item.path.replace(pathFor(""), "");
      all.push({ key: relKey, path: item.path, folder, size: item.size });
    }
    if (items.length > 0) {
      log(`  ${board.host}${board.path}: ${items.length} object(s)`);
    }
  }

  const totalBytes = all.reduce((sum, o) => sum + o.size, 0);
  log(`Listing complete — ${all.length} object(s) across ${boards.length} board(s), ${fmtBytes(totalBytes)} total.`);
  return all;
}

async function getObjectBuffer(obj: ObjectSummary): Promise<Uint8Array | null> {
  const bytes = await getObject(obj.path);
  if (!bytes) {
    warn(`GetObject failed/empty for "${obj.key}" — object may have disappeared between listing and read.`);
    return null;
  }
  return bytes;
}

async function deleteObjectByKey(obj: ObjectSummary): Promise<void> {
  await deleteObject(obj.path);
  log(`  deleted "${obj.key}" from TeraBox after successful IA upload.`);
}

// ---------- Folder discovery ----------

function discoverFolders(objects: ObjectSummary[]): Map<string, ObjectSummary[]> {
  const folders = new Map<string, ObjectSummary[]>();
  for (const obj of objects) {
    if (!folders.has(obj.folder)) folders.set(obj.folder, []);
    folders.get(obj.folder)!.push(obj);
  }

  log(`Discovered ${folders.size} folder(s) (board(s)) from ${objects.length} object(s).`);
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

// ---------- Internet Archive (IAS3) upload — unchanged flow, mirrors archive-thread.ts's identifier derivation ----------

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
  buffer: Uint8Array
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
    `Archived Futaba Channel threads from ${folder}, each saved as a ZIP (index.html + assets/). Uploaded automatically by the TeraBox-to-IA fallback sync sweep.`;

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
  items: ObjectSummary[];
  index: number;
}

function sampleRoundRobin(folders: Map<string, ObjectSummary[]>, limit: number): { folder: string; obj: ObjectSummary }[] {
  const queues: Queue[] = Array.from(folders.entries()).map(([folder, items]) => ({ folder, items, index: 0 }));

  const selected: { folder: string; obj: ObjectSummary }[] = [];
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
  const limit = parseInt(env.SAMPLE_LIMIT ?? "", 10) || 45;
  const deleteAfterSync = env.DELETE_FROM_R2_AFTER_SYNC !== "false";

  const allObjects = await listAllObjects();
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
      const buffer = await getObjectBuffer(obj);
      if (!buffer) {
        results.push({ key: obj.key, ok: false, reason: "object disappeared before read" });
        continue;
      }
      const ia = await uploadToInternetArchive(env, folder, threadId, buffer);
      results.push({ key: obj.key, folder, ...ia });

      if (ia.ok && deleteAfterSync) {
        await deleteObjectByKey(obj);
      } else if (ia.ok && !deleteAfterSync) {
        log(`  DELETE_FROM_R2_AFTER_SYNC=false — leaving "${obj.key}" in TeraBox.`);
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
  log("=== Sync TeraBox archive -> Internet Archive: starting ===");

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
    log("Nothing to sync — TeraBox is empty (as expected when the primary path is healthy or nothing has archived yet).");
  } else if (summary.failed > 0) {
    logError(`${summary.failed}/${summary.sampled} item(s) failed to sync — see failure detail above.`);
  } else {
    log(`All ${summary.uploaded} sampled item(s) synced successfully.`);
  }

  Deno.exit(summary.ok ? 0 : 1);
}

main().catch((e) => {
  logError(`Unhandled error in main(): ${e}`);
  Deno.exit(1);
});
