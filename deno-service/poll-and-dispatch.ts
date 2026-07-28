/**
 * Futaba Channel thread archiver — catalog polling (GitHub Actions).
 *
 * Ported from cf-worker/index.js's runArchivePass()/parseCatalog(). This
 * is job "poll" in .github/workflows/poll-and-archive.yml: fetch one
 * board's catalog, work out which threads actually need archiving, mark
 * each survivor "pending" directly in R2, and emit the resulting list as
 * a step output so the workflow's "archive" job can matrix over it and
 * run archive-thread.ts once per thread — all within the same workflow
 * run, no repository_dispatch call needed for this path.
 *
 * WHY THIS MOVED OUT OF THE WORKER: catalog parsing (a regex scan over
 * the whole catalog page) and the per-thread state checks are real, if
 * modest, CPU work, and running them every few minutes on a growing
 * catalog was contributing to Workers Free's 10ms CPU cap being
 * exceeded. GitHub Actions runners have no equivalent limit.
 *
 * The Worker no longer polls or dispatches anything. It's left with
 * POST /thread-complete (final state recording — unchanged) and
 * GET /sync-ia (manual/backup Internet Archive sync — unchanged). See
 * cf-worker/index.js.
 *
 * Required env vars: BOARD_HOST, BOARD_PATH, R2_ACCOUNT_ID,
 * R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME.
 * Optional: USER_AGENT, MIN_REPLIES (default 3), MAX_THREADS_PER_RUN
 * (default 52), MAX_ASSETS_PER_THREAD (default 40), MAX_ASSET_BYTES,
 * CXYL_COOKIE, OFFLOAD_BASE_URL, OFFLOAD_BASE_URL_F3, WORKER_CALLBACK_URL.
 */

import { AwsClient } from "https://esm.sh/aws4fetch@1.0.20";

// ---------- R2 (S3-compatible API) client ----------
//
// Inlined rather than imported from a shared module — this script only
// ever needs r2GetJson/r2PutJson (a state-check read and a "mark
// pending" write), so pulling in list/delete support it doesn't use
// would just be dead code. sync-ia.ts has its own copy of the fuller set
// it actually needs. If either script's R2 needs grow, keep watching for
// the two copies drifting apart — that's the tradeoff for not sharing a
// module.

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

function r2BucketUrl(key: string) {
  const accountId = requireEnv("R2_ACCOUNT_ID");
  const bucket = requireEnv("R2_BUCKET_NAME");
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${encodedKey}`;
}

/** Convenience wrapper for the common case of a small JSON state object. Returns `null` if missing or unparsable (fail open). */
async function r2GetJson<T>(key: string): Promise<T | null> {
  let res: Response;
  try {
    res = await getR2Client().fetch(r2BucketUrl(key), { method: "GET" });
  } catch (e) {
    console.error(`r2GetJson(${key}) failed to load:`, e);
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    console.error(`r2GetJson(${key}) failed to load: HTTP ${res.status}`);
    return null;
  }
  try {
    return JSON.parse(await res.text()) as T;
  } catch (_e) {
    return null;
  }
}

async function r2PutJson(key: string, value: unknown) {
  const res = await getR2Client().fetch(r2BucketUrl(key), {
    method: "PUT",
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`R2 PUT ${key} failed (${res.status}): ${text.slice(0, 300)}`);
  }
}

// ---------- Charset handling (only needed for the catalog page here) ----------

function decodeBuffer(buffer: ArrayBuffer, contentTypeHeader: string | null) {
  let charset: string | null = null;
  if (contentTypeHeader) {
    const m = /charset=([^;]+)/i.exec(contentTypeHeader);
    if (m) charset = m[1].trim().toLowerCase();
  }
  const attempts = charset ? [charset, "shift_jis", "utf-8"] : ["shift_jis", "utf-8"];
  for (const enc of attempts) {
    try {
      return { text: new TextDecoder(enc, { fatal: false }).decode(buffer) };
    } catch (_e) {
      // try next
    }
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(buffer) };
}

// ---------- Catalog parsing (unchanged from cf-worker/index.js) ----------

function parseCatalog(html: string) {
  const entries: { id: string; replies: number }[] = [];
  const re = /<a\s+href=["']?res\/(\d+)\.htm["']?[^>]*>[\s\S]*?<\/a>\s*<br>\s*<font[^>]*>(\d+)<\/font>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    entries.push({ id: m[1], replies: parseInt(m[2], 10) });
  }
  return entries;
}

// ---------- Offload uploaders (forwarded to archive-thread.ts per-thread) ----------

interface OffloadUploader {
  prefix: string;
  baseUrl: string;
}

const OFFLOAD_UPLOADERS: { prefix: string; envVar: string; defaultBaseUrl: string }[] = [
  { prefix: "fu", envVar: "OFFLOAD_BASE_URL", defaultBaseUrl: "https://dec.2chan.net/up2/src/" },
  { prefix: "f3", envVar: "OFFLOAD_BASE_URL_F3", defaultBaseUrl: "https://dec.2chan.net/up/src/" },
];

function resolveOffloadUploaders(): OffloadUploader[] {
  return OFFLOAD_UPLOADERS.map((u) => {
    const configured = Deno.env.get(u.envVar) || u.defaultBaseUrl;
    const baseUrl = configured.endsWith("/") ? configured : `${configured}/`;
    return { prefix: u.prefix, baseUrl };
  });
}

// ---------- Per-thread state keys ----------
//
// MUST stay byte-for-byte in sync with boardSlug()/archivedKeyFor()/
// pendingKeyFor() in cf-worker/index.js — both sides read and write the
// exact same R2 keys, so a mismatch here means the Worker's
// /thread-complete callback and this script's own checks silently stop
// agreeing on a thread's state.

interface Board {
  host: string;
  path: string;
}

function boardSlug(board: Board) {
  return `${board.host}${board.path}`.replace(/[^a-z0-9]+/gi, "_");
}

function archivedKeyFor(board: Board, threadId: string) {
  return `_state/archived/${boardSlug(board)}/${threadId}.json`;
}

function pendingKeyFor(board: Board, threadId: string) {
  return `_state/pending/${boardSlug(board)}/${threadId}.json`;
}

interface ArchivedState {
  replies: number;
  archivedAt: number;
  key?: string;
}
interface PendingState {
  replies: number;
  dispatchedAt: number;
}

// Keep in sync with PENDING_TIMEOUT_MS in cf-worker/index.js.
const PENDING_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// ---------- Step output helper ----------

/**
 * Write a (possibly multiline / JSON-containing) value to $GITHUB_OUTPUT
 * using the heredoc-style delimiter format, which is safe regardless of
 * quotes or special characters in `value`.
 */
async function writeOutput(name: string, value: string) {
  const path = Deno.env.get("GITHUB_OUTPUT");
  if (!path) {
    console.log(`(GITHUB_OUTPUT not set — would write) ${name}=${value}`);
    return;
  }
  await Deno.writeTextFile(path, `${name}<<__EOF__\n${value}\n__EOF__\n`, { append: true });
}

// ---------- Main ----------

async function main() {
  const board: Board = { host: requireEnv("BOARD_HOST"), path: requireEnv("BOARD_PATH") };
  const userAgent = Deno.env.get("USER_AGENT") || "FutabaThreadArchiver/1.0 (personal archive)";
  const minReplies = parseInt(Deno.env.get("MIN_REPLIES") || "", 10) || 3;
  const maxThreadsPerRun = parseInt(Deno.env.get("MAX_THREADS_PER_RUN") || "", 10) || 52;
  const maxAssetsPerThread = parseInt(Deno.env.get("MAX_ASSETS_PER_THREAD") || "", 10) || 40;
  const maxAssetBytes = parseInt(Deno.env.get("MAX_ASSET_BYTES") || "", 10) || 0;
  const cxylCookie = Deno.env.get("CXYL_COOKIE") || "100x100x0x0x0";
  const callbackUrl = Deno.env.get("WORKER_CALLBACK_URL") || "";
  const offloadUploaders = resolveOffloadUploaders();

  const catalogUrl = `https://${board.host}${board.path}futaba.php?mode=cat`;
  const res = await fetch(catalogUrl, { headers: { "User-Agent": userAgent, Cookie: `cxyl=${cxylCookie}` } });
  if (!res.ok) {
    throw new Error(`catalog fetch failed: ${res.status}`);
  }
  const buffer = await res.arrayBuffer();
  const { text: html } = decodeBuffer(buffer, res.headers.get("content-type"));
  const entries = parseCatalog(html);

  const candidates = entries.filter((e) => e.replies >= minReplies).slice(0, maxThreadsPerRun);
  const now = Date.now();

  // Filter out anything already archived at this reply count or higher,
  // and anything still within its pending window — same logic as the
  // Worker's runArchivePass() used to run, just checking R2 directly
  // instead of loading a shared per-board blob.
  const toArchive: { id: string; replies: number }[] = [];
  await Promise.all(
    candidates.map(async (entry) => {
      const [archivedState, pendingState] = await Promise.all([
        r2GetJson<ArchivedState>(archivedKeyFor(board, entry.id)),
        r2GetJson<PendingState>(pendingKeyFor(board, entry.id)),
      ]);
      if (archivedState && archivedState.replies >= entry.replies) return;
      if (pendingState && now - pendingState.dispatchedAt < PENDING_TIMEOUT_MS) return;
      toArchive.push(entry);
    })
  );

  // Mark each survivor "pending" up front — this is what stops a later
  // poll (a different board's run, or a manual re-run) from re-queuing
  // a thread whose archive job is already about to run.
  await Promise.all(
    toArchive.map((entry) =>
      r2PutJson(pendingKeyFor(board, entry.id), { replies: entry.replies, dispatchedAt: now })
    )
  );

  const threadPayloads = toArchive.map((entry) => ({
    threadId: entry.id,
    boardHost: board.host,
    boardPath: board.path,
    replies: entry.replies,
    userAgent,
    maxAssetsPerThread,
    maxAssetBytes,
    offloadUploaders,
    callbackUrl,
  }));

  console.log(
    `[${board.host}${board.path}] ${threadPayloads.length}/${candidates.length} candidate(s) queued for archiving ` +
      `(${entries.length} total in catalog)`
  );

  await writeOutput("threads", JSON.stringify(threadPayloads));
  await writeOutput("count", String(threadPayloads.length));
}

main().catch((e) => {
  console.error(`Fatal error: ${e}`);
  Deno.exit(1);
});
