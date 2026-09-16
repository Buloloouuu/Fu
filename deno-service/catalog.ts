/**
 * Futaba Channel thread archiver — Deno Deploy service.
 *
 * OWNS THE FULL CRON-TRIGGERED ARCHIVE PASS: Deno.cron() fires this
 * service per NATIVE_CRON_BOARDS board on its own schedule; GET_CRON_BOARDS
 * are triggered by an external "hit a URL on a schedule" service instead
 * (Deno.cron() registrations don't scale to ~90+ boards on most
 * platforms, Deno Deploy included).
 *
 * STORAGE: TeraBox (see terabox-store.ts), not R2 — no S3-compatible API,
 * no aws4fetch dependency, just terabox-api over TERABOX_NDUS.
 *
 * cf-worker/ HAS BEEN DELETED. This service now owns everything it used
 * to: /thread-complete (the GitHub Actions callback target),
 * /list, /download. There is no more Cloudflare Worker in this project.
 *
 * IA SYNC HAS BEEN REMOVED FROM THIS SERVICE. The scheduled GitHub
 * Actions workflow (sync-terabox-to-ia.yml / sync-terabox-to-ia.ts) is
 * now the only thing draining archived threads into Internet Archive.
 * There is no SYNC_CRON, no /sync-ia endpoint, and no IA_* env vars read
 * here anymore.
 *
 * BOARD CONFIG lives in boards.ts now — a single source of truth shared
 * with sync-terabox-to-ia.ts, instead of being duplicated across a
 * Worker file and a Deno file.
 *
 * CATALOG SORT CYCLING:
 *   futaba.php?mode=cat supports a &sort= query param, and the catalog
 *   only ever returns some fixed-size page of threads per sort order —
 *   so always hitting it with the same (default) sort means threads that
 *   never surface on that ordering can get missed entirely. Each call to
 *   runArchivePass() for a given board requests the NEXT sort in a fixed
 *   4-step cycle instead: 1) no sort param (site default), 2) sort=1
 *   (newest), 3) sort=2 (oldest), 4) sort=6 (most replies), then wraps.
 *   The current position is persisted in TeraBox
 *   (_state/sort-cycle/<boardSlug>.json), fail-open on any read/write
 *   problem — a broken TeraBox session never blocks an archive pass, it
 *   just means every pass uses the default sort instead of cycling.
 *
 * DEPLOYING:
 * Deno Deploy Classic (dash.deno.com) was discontinued July 20, 2026 —
 * deploy this on the new platform at console.deno.com (or via
 * `deployctl deploy`). Deno.cron() only actually fires on Deno Deploy
 * (or locally under the CLI with --unstable-cron, for testing). The new
 * platform's full Deno 2.0 runtime (including file system write access)
 * is required for terabox-store.ts's putObject to work — Deploy Classic
 * never supported writable fs APIs.
 *
 * ENV VARS THIS SERVICE NEEDS:
 *   CALLBACK_SECRET       — shared secret protecting /run, /catalog,
 *                           /get-cron-boards, /list, /download, and
 *                           /thread-complete via `Authorization: Bearer
 *                           ...` (or ?token=). Must match what
 *                           archive-thread.yml sends back as
 *                           CALLBACK_SECRET on its /thread-complete POST.
 *   GITHUB_TOKEN           — repo scope (classic PAT) or Contents: Read
 *                           and write (fine-grained PAT) on the target
 *                           repo, for dispatching repository_dispatch
 *                           events.
 *   GITHUB_OWNER / GITHUB_REPO
 *   CALLBACK_URL           — THIS service's own public URL +
 *                           /thread-complete, e.g.
 *                           https://your-service.deno.dev/thread-complete.
 *                           Sent to each GitHub Actions job so it knows
 *                           where to report results. Replaces the old
 *                           WORKER_CALLBACK_URL now that there's no
 *                           Worker.
 *   TERABOX_NDUS           — TeraBox session cookie. See terabox-store.ts.
 *   TERABOX_ROOT_DIR       — optional, defaults to /futaba-archive.
 *   BOARD_HOST / BOARD_PATH / ARCHIVE_CRON
 *                           — the "default" board + its schedule.
 *   MIN_REPLIES, MAX_THREADS_PER_RUN, MAX_THREADS_PER_DISPATCH,
 *   USER_AGENT, MAX_ASSETS_PER_THREAD, MAX_ASSET_BYTES, OFFLOAD_BASE_URL,
 *   OFFLOAD_BASE_URL_F3, CXYL_COOKIE
 *                           — same meaning/defaults as before.
 *
 * ENDPOINTS (all require CALLBACK_SECRET auth):
 *   GET /catalog?host=&path=[&cxyl=][&userAgent=][&sort=]
 *       -> raw {ok, entries, charset, byteLength, sort} — debugging/
 *          back-compat only. Does NOT participate in the sort cycle;
 *          pass &sort= yourself to test a specific ordering.
 *   GET /run?host=&path=   (or POST)
 *       -> manually trigger one full archive pass for a board. Also the
 *          endpoint a third-party cron service should hit for every
 *          board in GET_CRON_BOARDS. Each hit consumes the next step of
 *          that board's sort cycle, same as a native Deno.cron() firing.
 *   GET /get-cron-boards
 *       -> {ok, count, boards: [{host, path, runUrl}]} for every board in
 *          GET_CRON_BOARDS — copy/paste runUrl into your scheduler.
 *   POST /thread-complete
 *       -> called by the GitHub Actions job after each thread finishes;
 *          records archived/pending state in TeraBox.
 *   GET /list[?host=&path=]
 *       -> lists archived object keys/sizes for one or all boards.
 *   GET /download/<key>
 *       -> streams a specific archived ZIP back out of TeraBox.
 */

import {
  getJSON as tbGetJSON,
  putJSON as tbPutJSON,
  getObject as tbGetObject,
  deleteObject as tbDeleteObject,
  listDir as tbListDir,
  pathFor,
} from "./terabox-store.ts";
import { type Board, getBoards, boardSlug, archivedKeyFor, pendingKeyFor, GET_CRON_BOARDS } from "./boards.ts";

async function getThreadState(key: string): Promise<any | null> {
  return await tbGetJSON(pathFor(key));
}

async function putThreadState(key: string, value: unknown): Promise<void> {
  await tbPutJSON(pathFor(key), value);
}

// ---------- Catalog sort cycling ----------

const SORT_CYCLE: Array<{ param: number | null; label: string }> = [
  { param: null, label: "default" },
  { param: 1, label: "newest" },
  { param: 2, label: "oldest" },
  { param: 6, label: "most replies" },
];

function sortCycleKeyFor(board: Board): string {
  return `_state/sort-cycle/${boardSlug(board)}.json`;
}

async function getNextSortStep(board: Board): Promise<{ param: number | null; label: string }> {
  const key = sortCycleKeyFor(board);
  let index = 0;
  try {
    const state = await getThreadState(key);
    if (state && typeof state.index === "number") index = state.index;
  } catch (_e) {
    index = 0;
  }

  const step = SORT_CYCLE[((index % SORT_CYCLE.length) + SORT_CYCLE.length) % SORT_CYCLE.length];
  const nextIndex = (index + 1) % SORT_CYCLE.length;

  try {
    await putThreadState(key, { index: nextIndex });
  } catch (e) {
    console.error(`sort-cycle state write failed for ${board.host}${board.path}:`, e);
  }

  return step;
}

// ---------- Catalog parsing ----------

function parseCatalog(html: string): Array<{ id: string; replies: number }> {
  const entries: Array<{ id: string; replies: number }> = [];
  const re = /<a\s+href=["']?res\/(\d+)\.htm["']?[^>]*>[\s\S]*?<\/a>\s*<br>\s*<font[^>]*>(\d+)<\/font>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    entries.push({ id: m[1], replies: parseInt(m[2], 10) });
  }
  return entries;
}

function decodeBuffer(
  buffer: ArrayBuffer,
  contentTypeHeader: string | null
): { text: string; charset: string } {
  let charset: string | null = null;
  if (contentTypeHeader) {
    const m = /charset=([^;]+)/i.exec(contentTypeHeader);
    if (m) charset = m[1].trim().toLowerCase();
  }
  const attempts = charset ? [charset, "shift_jis", "utf-8"] : ["shift_jis", "utf-8"];
  for (const enc of attempts) {
    try {
      return { text: new TextDecoder(enc, { fatal: false }).decode(buffer), charset: enc };
    } catch (_e) {
      // try next
    }
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(buffer), charset: "utf-8" };
}

async function fetchCatalogEntries(
  board: Board,
  sortParam: number | null = null
): Promise<{ entries: Array<{ id: string; replies: number }>; charset: string; byteLength: number }> {
  const cxylCookie = Deno.env.get("CXYL_COOKIE") || "100x100x0x0x0";
  const userAgent = Deno.env.get("USER_AGENT") || "futaba-archiver-catalog-service";
  const catalogUrl = `https://${board.host}${board.path}futaba.php?mode=cat${
    sortParam !== null && sortParam !== undefined ? `&sort=${sortParam}` : ""
  }`;

  const res = await fetch(catalogUrl, {
    headers: { "User-Agent": userAgent, Cookie: `cxyl=${cxylCookie}` },
  });
  if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`);

  const buffer = await res.arrayBuffer();
  const { text: html, charset } = decodeBuffer(buffer, res.headers.get("content-type"));
  return { entries: parseCatalog(html), charset, byteLength: buffer.byteLength };
}

// ---------- Offload-uploader config ----------

const OFFLOAD_UPLOADERS = [
  { prefix: "fu", envVar: "OFFLOAD_BASE_URL", defaultBaseUrl: "https://dec.2chan.net/up2/src/" },
  { prefix: "f3", envVar: "OFFLOAD_BASE_URL_F3", defaultBaseUrl: "https://dec.2chan.net/up/src/" },
];

function resolveOffloadUploaders() {
  return OFFLOAD_UPLOADERS.map((u) => {
    const configured = Deno.env.get(u.envVar) || u.defaultBaseUrl;
    const baseUrl = configured.endsWith("/") ? configured : `${configured}/`;
    return { prefix: u.prefix, baseUrl };
  });
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// ---------- Dispatching a batch to GitHub Actions ----------

async function dispatchArchiveBatchViaGitHubActions(
  board: Board,
  threads: Array<{ id: string; replies: number }>
): Promise<{ ok: boolean; dispatched?: boolean; count?: number; status?: number; reason?: string }> {
  const githubToken = Deno.env.get("GITHUB_TOKEN");
  const githubOwner = Deno.env.get("GITHUB_OWNER");
  const githubRepo = Deno.env.get("GITHUB_REPO");
  const callbackUrl = Deno.env.get("CALLBACK_URL");

  if (!githubToken || !githubOwner || !githubRepo) {
    return { ok: false, reason: "GITHUB_TOKEN/GITHUB_OWNER/GITHUB_REPO not configured" };
  }
  if (!callbackUrl) {
    return { ok: false, reason: "CALLBACK_URL not configured" };
  }

  const clientPayload = {
    threads: threads.map((t) => ({ threadId: t.id, replies: t.replies })),
    boardHost: board.host,
    boardPath: board.path,
    userAgent: Deno.env.get("USER_AGENT"),
    maxAssetsPerThread: parseInt(Deno.env.get("MAX_ASSETS_PER_THREAD") ?? "", 10) || 70,
    maxAssetBytes: parseInt(Deno.env.get("MAX_ASSET_BYTES") ?? "", 10) || 0,
    offloadUploaders: resolveOffloadUploaders(),
    callbackUrl,
  };

  const dispatchUrl = `https://api.github.com/repos/${githubOwner}/${githubRepo}/dispatches`;

  let res: Response;
  try {
    res = await fetch(dispatchUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": Deno.env.get("USER_AGENT") || "futaba-archiver-deno-service",
      },
      body: JSON.stringify({ event_type: "archive-thread", client_payload: clientPayload }),
    });
  } catch (e) {
    return { ok: false, reason: `GitHub dispatch request failed: ${e}` };
  }

  // repository_dispatch returns 204 No Content on success.
  if (res.status !== 204) {
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, reason: `GitHub dispatch failed (${res.status}): ${text.slice(0, 300)}` };
  }

  return { ok: true, dispatched: true, count: threads.length };
}

// How long a thread can sit "pending" before a later pass is allowed to
// re-dispatch it.
const PENDING_TIMEOUT_MS = 30 * 60 * 1000;

// ---------- Archive pass ----------

async function runArchivePass(board: Board) {
  const sortStep = await getNextSortStep(board);

  let catalog: { entries: Array<{ id: string; replies: number }>; charset: string; byteLength: number };
  try {
    catalog = await fetchCatalogEntries(board, sortStep.param);
  } catch (e) {
    return {
      ok: false,
      board: `${board.host}${board.path}`,
      sort: sortStep.label,
      reason: String((e as Error).message || e),
    };
  }
  const entries = catalog.entries;

  const minReplies = parseInt(Deno.env.get("MIN_REPLIES") ?? "", 10) || 3;
  const maxPerRun = parseInt(Deno.env.get("MAX_THREADS_PER_RUN") ?? "", 10) || 150;
  const maxPerDispatch = Math.max(1, parseInt(Deno.env.get("MAX_THREADS_PER_DISPATCH") ?? "", 10) || 30);

  const candidates = entries.filter((e) => e.replies >= minReplies).slice(0, maxPerRun);
  const now = Date.now();

  const checked = await Promise.all(
    candidates.map(async (entry) => {
      const [archivedState, pendingState] = await Promise.all([
        getThreadState(archivedKeyFor(board, entry.id)),
        getThreadState(pendingKeyFor(board, entry.id)),
      ]);
      if (archivedState && archivedState.replies >= entry.replies) return null;
      if (pendingState && now - pendingState.dispatchedAt < PENDING_TIMEOUT_MS) return null;
      return entry;
    })
  );
  const toArchive = checked.filter((e): e is { id: string; replies: number } => e !== null);

  const batches = chunkArray(toArchive, maxPerDispatch);
  const batchResults: any[] = [];
  let dispatchedCount = 0;

  for (const batch of batches) {
    const threadIds = batch.map((e) => e.id);
    try {
      const result = await dispatchArchiveBatchViaGitHubActions(board, batch);
      if (result.ok) {
        const dispatchedAt = Date.now();
        await Promise.all(
          batch.map((entry) => putThreadState(pendingKeyFor(board, entry.id), { replies: entry.replies, dispatchedAt }))
        );
        dispatchedCount += batch.length;
      }
      batchResults.push({ threadIds, ...result });
    } catch (e) {
      batchResults.push({ threadIds, ok: false, reason: String(e) });
    }
  }

  const failedBatches = batchResults.filter((r) => !r.ok);
  for (const r of failedBatches) {
    console.error(
      `[${board.host}${board.path}] failed to dispatch batch [${r.threadIds.join(",")}]: ${r.reason || `status ${r.status}`}`
    );
  }
  console.log(
    `[${board.host}${board.path}] run complete — sort=${sortStep.label} catalog=${entries.length} candidates=${candidates.length} toArchive=${toArchive.length} dispatchedThreads=${dispatchedCount} batches=${batches.length} failedBatches=${failedBatches.length}`
  );

  return {
    ok: true,
    board: `${board.host}${board.path}`,
    sort: sortStep.label,
    catalogEntries: entries.length,
    candidates: candidates.length,
    dispatchedCount,
    batches: batchResults,
  };
}

// ---------- Deno.cron registration — one per NATIVE_CRON_BOARDS entry ----------

for (const board of getBoards()) {
  if (!board.cron) continue;
  Deno.cron(`archive-${boardSlug(board)}`, board.cron, async () => {
    try {
      await runArchivePass(board);
    } catch (e) {
      console.error(`scheduled archive pass for ${board.host}${board.path} failed:`, e);
    }
  });
}

// ---------- HTTP handlers ----------

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

function checkAuth(request: Request): boolean {
  const secret = Deno.env.get("CALLBACK_SECRET");
  if (!secret) return true; // no secret configured — open access (not recommended)
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return token === secret;
}

function boardFromQuery(url: URL): Board {
  const host = url.searchParams.get("host");
  const path = url.searchParams.get("path");
  if (host && path) return { host, path };
  return { host: Deno.env.get("BOARD_HOST") ?? "", path: Deno.env.get("BOARD_PATH") ?? "" };
}

Deno.serve(async (request: Request) => {
  const url = new URL(request.url);

  if (url.pathname === "/run") {
    if (!checkAuth(request)) return unauthorized();
    const result = await runArchivePass(boardFromQuery(url));
    return Response.json(result);
  }

  if (url.pathname === "/catalog") {
    if (!checkAuth(request)) return unauthorized();
    const host = url.searchParams.get("host");
    const path = url.searchParams.get("path");
    if (!host || !path) {
      return Response.json({ ok: false, reason: "missing host/path query params" }, { status: 400 });
    }
    const sortRaw = url.searchParams.get("sort");
    const sortParam = sortRaw !== null && sortRaw !== "" ? parseInt(sortRaw, 10) : null;
    try {
      const { entries, charset, byteLength } = await fetchCatalogEntries({ host, path }, sortParam);
      return Response.json({ ok: true, entries, charset, byteLength, sort: sortParam });
    } catch (e) {
      return Response.json({ ok: false, reason: String(e) }, { status: 502 });
    }
  }

  if (url.pathname === "/get-cron-boards") {
    if (!checkAuth(request)) return unauthorized();
    const secret = Deno.env.get("CALLBACK_SECRET") || "";
    const boards = GET_CRON_BOARDS.filter((b) => b.host && b.path).map((b) => ({
      host: b.host,
      path: b.path,
      runUrl: `${url.origin}/run?host=${encodeURIComponent(b.host)}&path=${encodeURIComponent(b.path)}${
        secret ? `&token=${encodeURIComponent(secret)}` : ""
      }`,
    }));
    return Response.json({ ok: true, count: boards.length, boards });
  }

  if (url.pathname === "/thread-complete" && request.method === "POST") {
    if (!checkAuth(request)) return unauthorized();
    let body: any;
    try {
      body = await request.json();
    } catch (_e) {
      return Response.json({ ok: false, reason: "invalid JSON body" }, { status: 400 });
    }

    const { threadId, boardHost, boardPath, replies, ok, key, assetCount, reason } = body;
    if (!threadId || !boardHost || !boardPath) {
      return Response.json({ ok: false, reason: "missing required fields: threadId, boardHost, boardPath" }, { status: 400 });
    }

    const board: Board = { host: boardHost, path: boardPath };
    const archivedKey = archivedKeyFor(board, threadId);
    const pendingKey = pendingKeyFor(board, threadId);

    if (ok) {
      const prevArchived = await getThreadState(archivedKey);
      await putThreadState(archivedKey, {
        replies: replies ?? prevArchived?.replies ?? 0,
        archivedAt: Date.now(),
        key,
      });
    } else {
      console.error(`[${boardHost}${boardPath}] thread ${threadId} archive failed: ${reason}`);
    }

    await tbDeleteObject(pathFor(pendingKey));

    return Response.json({ ok: true, recorded: ok ? "archived" : "failed", assetCount });
  }

  if (url.pathname === "/list") {
    if (!checkAuth(request)) return unauthorized();
    const host = url.searchParams.get("host");
    const path = url.searchParams.get("path");
    const boards = host && path ? [{ host, path }] : getBoards();

    const perBoard = await Promise.all(
      boards.map(async (board) => {
        const prefix = pathFor(`${board.host}${board.path}`.replace(/\/+/g, "/"));
        const items = await tbListDir(prefix);
        return items.map((o) => ({ key: o.path, size: o.size }));
      })
    );
    return Response.json(perBoard.flat());
  }

  if (url.pathname.startsWith("/download/")) {
    if (!checkAuth(request)) return unauthorized();
    const key = decodeURIComponent(url.pathname.replace("/download/", ""));
    const bytes = await tbGetObject(pathFor(key));
    if (!bytes) return new Response("Not found", { status: 404 });
    return new Response(bytes, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${key.split("/").pop()}"`,
      },
    });
  }

  return new Response(
    "Futaba archiver (Deno, TeraBox-backed). Endpoints: GET /run?token=...[&host=&path=], GET /catalog?token=...&host=&path=[&cxyl=][&userAgent=][&sort=], GET /get-cron-boards?token=..., POST /thread-complete (called by GitHub Actions), GET /list?token=...[&host=&path=], GET /download/<key>?token=.... NATIVE_CRON_BOARDS run automatically via Deno.cron(); GET_CRON_BOARDS need external scheduling. IA sync runs entirely from sync-terabox-to-ia.yml now, not from this service.",
    { status: 200 }
  );
});
