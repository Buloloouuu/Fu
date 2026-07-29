/**
 * Futaba Channel thread archiver — Internet Archive sync (GitHub Actions).
 *
 * Ported from cf-worker/index.js's syncToInternetArchive(). This is now
 * the PRIMARY sync path, run on its own schedule
 * (.github/workflows/sync-ia.yml, default hourly) with no CPU-time cap to
 * worry about — the old version was the thing actually throwing
 * `exceededCpu` on the Worker's hourly SYNC_CRON, since it does real
 * per-byte work (reading full zip/html buffers into memory, building
 * IAS3 header strings) rather than just orchestration.
 *
 * cf-worker/index.js keeps its own copy of this same logic reachable at
 * GET /sync-ia?token=... as a manual/backup trigger — see the comment
 * there. Both write to the same R2 bucket and the same per-board
 * "_state/ia_synced/<board>.json" blob. That blob is NOT given the
 * per-thread-key treatment archived/pending state got, because it's
 * expected to have only one active writer at a time in normal use (this
 * scheduled job); if you trigger the manual backup while this job
 * happens to be mid-run, the worst case is a lost update to that one
 * bookkeeping blob (a thread gets IA-synced twice, harmlessly), not lost
 * R2/IA data.
 *
 * Required env vars: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 * R2_BUCKET_NAME, IA_ACCESS_KEY, IA_SECRET_KEY.
 * Optional: BOARD_HOST/BOARD_PATH (default board), MAX_SYNC_PER_RUN
 * (default 20 — can be raised now that there's no CPU cap forcing it
 * low, though R2/IA's own rate limits still apply), DELETE_FROM_R2_AFTER_SYNC,
 * IA_IDENTIFIER, IA_ITEM_TITLE, IA_ITEM_DESCRIPTION, IA_COLLECTION,
 * IA_MEDIATYPE.
 */

import { AwsClient } from "https://esm.sh/aws4fetch@1.0.20";

// ---------- R2 (S3-compatible API) client ----------
//
// Inlined rather than imported from a shared module — this is the fuller
// set (get/put/delete/list) this script actually needs, since it walks
// the whole bucket and deletes synced objects. poll-and-dispatch.ts has
// its own smaller copy (just get/put JSON) since that's all it needs.
// If either script's R2 needs grow, keep watching for the two copies
// drifting apart — that's the tradeoff for not sharing a module.

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

let r2Client: InstanceType<typeof AwsClient> | null = null;
function getR2Client() {
  if (!r2Client) {
    r2Client = new AwsClient({
      accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
      service: "s3",
      region: "auto",
    });
  }
  return r2Client;
}

function r2BucketUrl(key?: string) {
  const accountId = requireEnv("R2_ACCOUNT_ID");
  const bucket = requireEnv("R2_BUCKET_NAME");
  const base = `https://${accountId}.r2.cloudflarestorage.com/${bucket}`;
  if (!key) return base;
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${base}/${encodedKey}`;
}

async function r2Get(key: string): Promise<{ buffer: ArrayBuffer; contentType: string | null } | null> {
  const res = await getR2Client().fetch(r2BucketUrl(key), { method: "GET" });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`R2 GET ${key} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return { buffer: await res.arrayBuffer(), contentType: res.headers.get("content-type") };
}

/** Convenience wrapper for the common case of a small JSON state object. Returns `null` if missing or unparsable (fail open). */
async function r2GetJson<T>(key: string): Promise<T | null> {
  let obj: Awaited<ReturnType<typeof r2Get>>;
  try {
    obj = await r2Get(key);
  } catch (e) {
    console.error(`r2GetJson(${key}) failed to load:`, e);
    return null;
  }
  if (!obj) return null;
  try {
    return JSON.parse(new TextDecoder().decode(obj.buffer)) as T;
  } catch (_e) {
    return null;
  }
}

async function r2Put(key: string, body: Uint8Array | string, contentType: string) {
  const res = await getR2Client().fetch(r2BucketUrl(key), {
    method: "PUT",
    body,
    headers: { "Content-Type": contentType },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`R2 PUT ${key} failed (${res.status}): ${text.slice(0, 300)}`);
  }
}

async function r2PutJson(key: string, value: unknown) {
  await r2Put(key, JSON.stringify(value), "application/json");
}

/** Deleting a key that doesn't exist is treated as success — same "harmless no-op" semantics as cf-worker/index.js's deleteThreadState. */
async function r2Delete(key: string) {
  const res = await getR2Client().fetch(r2BucketUrl(key), { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new Error(`R2 DELETE ${key} failed (${res.status}): ${text.slice(0, 300)}`);
  }
}

interface R2ListedObject {
  key: string;
  size: number;
}

function decodeXmlEntities(s: string) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * List every object under `prefix` via R2's S3-compatible ListObjectsV2
 * API, following continuation tokens until the full listing is
 * retrieved. The response body is XML; parsed here with simple regexes
 * over the well-documented, stable <Contents><Key>...</Key><Size>...
 * </Size></Contents> shape rather than pulling in a full XML parser
 * dependency for something this small.
 */
async function r2List(prefix: string): Promise<R2ListedObject[]> {
  const results: R2ListedObject[] = [];
  let continuationToken: string | null = null;

  do {
    const params = new URLSearchParams({ "list-type": "2", prefix });
    if (continuationToken) params.set("continuation-token", continuationToken);

    const res = await getR2Client().fetch(`${r2BucketUrl()}?${params.toString()}`, { method: "GET" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`R2 LIST ${prefix} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const xml = await res.text();

    const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;
    let m: RegExpExecArray | null;
    while ((m = contentsRe.exec(xml)) !== null) {
      const block = m[1];
      const keyMatch = /<Key>([\s\S]*?)<\/Key>/.exec(block);
      const sizeMatch = /<Size>([\s\S]*?)<\/Size>/.exec(block);
      if (keyMatch) {
        results.push({ key: decodeXmlEntities(keyMatch[1]), size: sizeMatch ? parseInt(sizeMatch[1], 10) : 0 });
      }
    }

    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const tokenMatch = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
    continuationToken = truncated && tokenMatch ? tokenMatch[1] : null;
  } while (continuationToken);

  return results;
}

interface Board {
  host: string;
  path: string;
}

/**
 * Keep this board list in sync with ADDITIONAL_BOARDS + BOARD_HOST/
 * BOARD_PATH in cf-worker/index.js, and with the cron table in
 * .github/workflows/poll-and-archive.yml. Unlike the poll script (which
 * only ever handles the one board matching whichever cron fired), this
 * sync pass walks every configured board in a single run each time it's
 * invoked, same as the original Worker version did.
 */
function getBoards(): Board[] {
  return [
    { host: "img.2chan.net", path: "/b/" },
    { host: "may.2chan.net", path: "/b/" },
    { host: "jun.2chan.net", path: "/jun/" },
    { host: "dec.2chan.net", path: "/dec/" },
  ];
}

function boardSlug(board: Board) {
  return `${board.host}${board.path}`.replace(/[^a-z0-9]+/gi, "_");
}

function iaSyncedKeyFor(board: Board) {
  return `_state/ia_synced/${boardSlug(board)}.json`;
}

// ---------- Internet Archive (IAS3) — unchanged logic from cf-worker/index.js ----------

function sanitizeIaIdentifierPart(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

function iaHeaderValue(str: string) {
  if (/^[\x20-\x7E]*$/.test(str)) return str;
  return `uri(${encodeURIComponent(str)})`;
}

function iaItemIdentifier(board: Board) {
  const configured = Deno.env.get("IA_IDENTIFIER");
  if (configured) return sanitizeIaIdentifierPart(configured).slice(0, 100).replace(/-+$/, "");
  const slug = sanitizeIaIdentifierPart(`${board.host}${board.path}`);
  return `futaba-archive-${slug}`.slice(0, 100).replace(/-+$/, "");
}

function iaFilenameFor(board: Board, threadId: string, ext: string) {
  const slug = sanitizeIaIdentifierPart(`${board.host}${board.path}`);
  return `${slug}_${threadId}.${ext}`;
}

interface IaResult {
  ok: boolean;
  status?: number;
  reason?: string;
  identifier?: string;
  filename?: string;
  detailsUrl?: string;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * IAS3 throttles uploads per access key across your whole account (not
 * per-item), returning 503 with `<Code>SlowDown</Code>` /
 * `accesskey_tasks_queued exceeds rationed amount` once too many upload
 * tasks are queued at once. This shows up more on later boards in a run
 * (their uploads land after earlier boards' tasks are already queued),
 * not because anything is wrong with those uploads specifically. Retry
 * with exponential backoff rather than giving up on the first SlowDown —
 * IA's own guidance for this error is "wait and retry", not "reduce
 * request rate mid-flight" in some more granular way.
 */
const IA_SLOWDOWN_RETRIES = 5;
const IA_SLOWDOWN_BASE_DELAY_MS = 10_000; // 10s, 20s, 40s, 80s, 160s

async function uploadToInternetArchive(
  board: Board,
  filename: string,
  buffer: ArrayBuffer,
  contentType: string
): Promise<IaResult> {
  const accessKey = Deno.env.get("IA_ACCESS_KEY");
  const secretKey = Deno.env.get("IA_SECRET_KEY");
  if (!accessKey || !secretKey) {
    return { ok: false, reason: "IA_ACCESS_KEY/IA_SECRET_KEY not configured" };
  }
  const identifier = iaItemIdentifier(board);
  const uploadUrl = `https://s3.us.archive.org/${identifier}/${filename}`;

  const title = Deno.env.get("IA_ITEM_TITLE") || `Futaba thread archive (${board.host}${board.path})`;
  const description =
    Deno.env.get("IA_ITEM_DESCRIPTION") ||
    `Archived Futaba Channel threads from ${board.host}${board.path}. Uploaded automatically by futaba-archiver.`;

  for (let attempt = 0; attempt <= IA_SLOWDOWN_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(uploadUrl, {
        method: "PUT",
        redirect: "follow", // IAS3 commonly issues 307s during upload
        headers: {
          Authorization: `LOW ${accessKey}:${secretKey}`,
          "x-amz-auto-make-bucket": "1",
          "x-archive-ignore-preexisting-bucket": "1",
          // NOTE: test_collection auto-deletes items after 30 days — do not
          // use it for anything you want to keep.
          "x-archive-meta-collection": Deno.env.get("IA_COLLECTION") || "opensource",
          "x-archive-meta-mediatype": Deno.env.get("IA_MEDIATYPE") || "web",
          "x-archive-meta-title": iaHeaderValue(title),
          "x-archive-meta-description": iaHeaderValue(description),
          "x-archive-meta-subject": "futaba;imageboard;archive",
          "x-archive-queue-derive": "0",
          "Content-Type": contentType,
        },
        body: buffer,
      });
    } catch (e) {
      return { ok: false, reason: `IA upload request failed: ${e}` };
    }

    if (res.ok) {
      return { ok: true, status: res.status, identifier, filename, detailsUrl: `https://archive.org/details/${identifier}` };
    }

    const text = await res.text().catch(() => "");
    const isSlowDown = res.status === 503 && /SlowDown/i.test(text);
    if (!isSlowDown || attempt === IA_SLOWDOWN_RETRIES) {
      return { ok: false, status: res.status, reason: text.slice(0, 500), identifier, filename };
    }

    const delay = IA_SLOWDOWN_BASE_DELAY_MS * 2 ** attempt;
    console.log(`[${identifier}] IA SlowDown on ${filename}, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${IA_SLOWDOWN_RETRIES})`);
    await sleep(delay);
  }

  // Unreachable — loop always returns, but keeps TypeScript happy.
  return { ok: false, reason: "exhausted retries" };
}

interface IaSyncedEntry {
  identifier: string;
  syncedAt: number;
}

async function syncBoard(board: Board, maxPerBoard: number, deleteAfterSync: boolean) {
  const prefix = `${board.host}${board.path}`.replace(/\/+/g, "/");
  const objects = await r2List(prefix);

  const iaSyncedKey = iaSyncedKeyFor(board);
  const iaSynced = (await r2GetJson<Record<string, IaSyncedEntry>>(iaSyncedKey)) || {};
  let changed = false;

  const results: (IaResult & { key: string })[] = [];
  let processed = 0;

  for (const obj of objects) {
    if (processed >= maxPerBoard) break;
    // "_state/..." keys live under a different top-level prefix than any
    // board's own host+path prefix, so they shouldn't appear in this
    // listing at all — this is a harmless extra guard, not load-bearing.
    if (obj.key.includes("_state/")) continue;

    // Handles both this experiment's output and the alternate
    // self-contained-HTML worker's output, so this one sync pass covers
    // whichever format(s) actually ended up in the bucket.
    const match = /([^/]+)\.(zip|html)$/i.exec(obj.key);
    if (!match) continue;
    const [, threadId, ext] = match;
    processed++;

    const contentType = ext.toLowerCase() === "zip" ? "application/zip" : "text/html; charset=utf-8";
    const filename = iaFilenameFor(board, threadId, ext);

    try {
      const object = await r2Get(obj.key);
      if (!object) continue;

      const ia = await uploadToInternetArchive(board, filename, object.buffer, contentType);
      results.push({ key: obj.key, ...ia });

      if (ia.ok && ia.identifier) {
        iaSynced[obj.key] = { identifier: ia.identifier, syncedAt: Date.now() };
        changed = true;
        if (deleteAfterSync) await r2Delete(obj.key);
      }
    } catch (e) {
      results.push({ key: obj.key, ok: false, reason: String(e) });
    }

    // Small pacing delay between uploads (not just on failure) — spreads
    // out how fast tasks land in IA's per-access-key queue in the first
    // place, so later boards in this same run are less likely to walk
    // straight into a SlowDown that earlier boards' uploads already
    // primed. Cheap insurance against the retry loop above having to do
    // much work.
    await sleep(1500);
  }

  if (changed) await r2PutJson(iaSyncedKey, iaSynced);

  return { board: `${board.host}${board.path}`, scanned: objects.length, processed, results };
}

async function main() {
  const maxPerBoard = parseInt(Deno.env.get("MAX_SYNC_PER_RUN") || "", 10) || 20;
  const deleteAfterSync = Deno.env.get("DELETE_FROM_R2_AFTER_SYNC") !== "false";

  const boards = getBoards();
  let anyFailed = false;

  for (const board of boards) {
    const result = await syncBoard(board, maxPerBoard, deleteAfterSync);
    console.log(`[${result.board}] synced ${result.processed}/${result.scanned} object(s) considered`);

    const failed = result.results.filter((r) => !r.ok);
    if (failed.length > 0) {
      anyFailed = true;
      console.error(`[${result.board}] ${failed.length} item(s) failed:`, JSON.stringify(failed).slice(0, 2000));
    }
  }

  // Non-zero exit if anything failed, so a run with sync failures shows
  // up as a red run in the Actions tab rather than silently succeeding.
  if (anyFailed) Deno.exit(1);
}

main().catch((e) => {
  console.error(`Fatal error: ${e}`);
  Deno.exit(1);
});
