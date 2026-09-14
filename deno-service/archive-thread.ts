/**
 * Futaba Channel thread archiver — GitHub Actions half.
 *
 * ARCHITECTURE CHANGE (R2 -> GitHub Releases):
 *
 * This used to upload the finished ZIP straight into Cloudflare R2 via
 * R2's S3-compatible API (aws4fetch). Cloudflare (Worker + R2) has been
 * dropped from this project entirely. The ZIP now goes to a GitHub
 * Release asset instead:
 *   - one Release per board, tagged with that board's slug
 *     (boardSlug(host, path)), created on first use
 *   - one asset per thread inside that release, named "<threadId>.zip"
 *   - re-archiving a thread (more replies than last time) deletes the
 *     old same-named asset first, since GitHub's upload API rejects a
 *     duplicate asset name on a release rather than overwriting it —
 *     unlike R2's PUT-by-key, which just silently replaced the object.
 *
 * This still runs as a one-shot CLI script inside a GitHub Actions job,
 * triggered per-batch by a `repository_dispatch` event that the Deno
 * service sends (see deno-service/catalog.ts's
 * dispatchArchiveBatchViaGitHubActions, and .github/workflows/
 * archive-thread.yml, which fans a batch back out into one matrix job
 * per thread).
 *
 * Because GitHub's repository_dispatch API is fire-and-forget, this
 * script reports back over HTTP itself once it's done: it POSTs a small
 * JSON result to a callback URL (the Deno service's own
 * /thread-complete endpoint — see deno-service/catalog.ts), authenticated
 * with a shared secret. The Deno service uses that callback to update
 * its "archived"/"pending" state, which now also lives in this repo
 * (see deno-service/catalog.ts's GitHub-backed state helpers) rather
 * than in R2.
 *
 * INPUT: a single JSON blob in the PAYLOAD_JSON environment variable,
 * shaped like:
 *   {
 *     "threadId": "12345678",
 *     "boardHost": "may.2chan.net",
 *     "boardPath": "/b/",
 *     "replies": 42,                  // echoed back in the callback so the
 *                                     // Deno service can record the right count
 *     "userAgent": "...",             // optional
 *     "maxAssetsPerThread": 40,       // optional
 *     "maxAssetBytes": 0,             // optional
 *     "offloadUploaders": [{ "prefix": "fu", "baseUrl": "..." }],
 *     "callbackUrl": "https://your-deno-service.deno.dev/thread-complete"
 *   }
 * The Deno service builds this payload and sends it as GitHub's
 * `client_payload`; the workflow YAML
 * (.github/workflows/archive-thread.yml) forwards it into PAYLOAD_JSON
 * verbatim via `toJson(github.event.client_payload)`, so this script
 * never needs to parse individual env vars per field.
 *
 * Required environment variables:
 *   GITHUB_TOKEN     — the job's auto-issued per-run token
 *                      (${{ secrets.GITHUB_TOKEN }} in the workflow YAML,
 *                      NOT a manually created PAT). Needs
 *                      `permissions: contents: write` set on the job so
 *                      it's allowed to create releases and upload assets.
 *   GITHUB_REPOSITORY — set automatically by every GitHub Actions
 *                      runner as "owner/repo"; not something you need to
 *                      pass in yourself.
 *   CALLBACK_SECRET   — must match the Deno service's CALLBACK_SECRET;
 *                      sent as `Authorization: Bearer ...` on the
 *                      callback POST.
 */

// ---------- Charset handling ----------

function decodeBuffer(buffer: ArrayBuffer, contentTypeHeader: string | null) {
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

/**
 * The saved index.html is always written out as fresh UTF-8 bytes, so any
 * stale "charset=Shift_JIS" declaration left in the page needs rewriting —
 * otherwise a browser opening index.html straight from the zip (no MIME
 * wrapper to override it) would mis-decode all the Japanese text.
 */
function forceUtf8Meta(html: string) {
  let out = html.replace(
    /<meta\s+http-equiv=["']?Content-type["']?\s+content=["']text\/html;\s*charset=[^"'>]+["']\s*\/?>/i,
    '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">'
  );
  out = out.replace(
    /<meta\s+charset\s*=\s*["']?[^"'>\s]+["']?\s*\/?>/i,
    '<meta charset="UTF-8">'
  );
  return out;
}

// ---------- Asset extraction ----------

const ASSET_HREF_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp|webm|mp4|txt)(\?|#|$)/i;

/**
 * Pull out URLs that are actual content assets — post images, video,
 * attached text files, and the stylesheet — while ignoring ad/tracking
 * iframes and scripts. Only <img>/<video>/<source> src, <link
 * rel=stylesheet> href, and <a href> links to media/text extensions are
 * considered; iframe/script/object src is skipped on purpose.
 */
function extractAssetUrls(html: string) {
  const urls = new Set<string>();
  const attrValue = (tag: string, attr: string) => {
    const m = new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
    return m ? m[1] ?? m[2] ?? m[3] : null;
  };

  const tagRe = /<(?:img|video|source)\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const url = attrValue(m[0], "src");
    if (url) urls.add(url);
  }

  const linkRe = /<link\b[^>]*>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    if (/rel\s*=\s*["']?stylesheet/i.test(tag)) {
      const url = attrValue(tag, "href");
      if (url) urls.add(url);
    }
  }

  const hrefRe = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  while ((m = hrefRe.exec(html)) !== null) {
    const url = m[1] ?? m[2] ?? m[3];
    if (url && ASSET_HREF_EXTENSIONS.test(url)) {
      urls.add(url);
    }
  }

  return [...urls];
}

/**
 * Futaba wraps each posted image as `<a href="FULL"><img src="THUMB" ...>
 * </a>` — a link to the full-size original around a smaller thumbnail
 * preview. Fetching both doubles outbound requests (and bytes) per image
 * for no benefit, since the full-size original is a superset of what the
 * thumbnail shows. This finds those pairs so the thumbnail can be
 * skipped entirely: only the full-size URL goes out over the network,
 * and both the <a href> and the <img src> end up pointing at that one
 * fetched local asset.
 *
 * Returns a Map<thumbRawUrl, fullRawUrl>.
 */
function extractLinkedThumbnails(html: string) {
  const map = new Map<string, string>();
  const pairRe =
    /<a\b[^>]*\bhref\s*=\s*(["'])([^"']+)\1[^>]*>\s*<img\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\3[^>]*>\s*<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(html)) !== null) {
    const full = m[2];
    const thumb = m[4];
    if (full && thumb && full !== thumb && ASSET_HREF_EXTENSIONS.test(full)) {
      map.set(thumb, full);
    }
  }
  return map;
}

/**
 * Pull just the stylesheet URL(s) referenced via <link rel="stylesheet">.
 * Kept separate from extractAssetUrls so the caller can single CSS out
 * for the warm-instance cache below without touching post images/video.
 */
function extractStylesheetUrls(html: string) {
  const urls = new Set<string>();
  const linkRe = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    if (/rel\s*=\s*["']?stylesheet/i.test(tag)) {
      const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
      const url = hrefMatch ? hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] : null;
      if (url) urls.add(url);
    }
  }
  return urls;
}

/**
 * NOTE ON THE CSS CACHE: an earlier Deno Deploy version cached each
 * board's shared stylesheet in a module-level Map so a warm isolate
 * could skip re-fetching it across several calls in a row. That trick
 * doesn't apply here — each GitHub Actions job is a fresh process (a new
 * VM), so there's no "warm instance" to carry a cache between threads.
 * The stylesheet is simply fetched fresh, once, per job. If this ever
 * becomes worth optimizing, `actions/cache` keyed on board host could
 * persist it across job runs, but for a single small CSS file it isn't
 * worth the added complexity.
 */

// ---------- Offload uploaders (generic — config comes from the payload) ----------

const OFFLOAD_EXTENSIONS = "jpe?g|png|gif|webp|bmp|webm|mp4|txt";

interface OffloadUploader {
  prefix: string; // e.g. "fu", "f3"
  baseUrl: string; // absolute, trailing-slash-normalized by the caller
}

/**
 * Bare filenames like "fu6988461.jpg" or "f3204512.png" need their
 * uploader's base URL prepended to actually be fetchable. Scans the raw
 * HTML/text for these patterns (not just tag attributes) since they can
 * appear as plain text in a post body too. `uploaders` is whatever list
 * the Deno service sent in this request — this function has no built-in
 * knowledge of which prefixes exist.
 */
function extractOffloadedAssetUrls(html: string, uploaders: OffloadUploader[]) {
  const urls = new Set<string>();
  for (const uploader of uploaders) {
    const base = uploader.baseUrl.endsWith("/") ? uploader.baseUrl : `${uploader.baseUrl}/`;
    const re = new RegExp(`\\b${uploader.prefix}\\d+\\.(?:${OFFLOAD_EXTENSIONS})\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      urls.add(`${base}${m[0]}`);
    }
  }
  return [...urls];
}

/**
 * Rewrite src="<prefix>....ext" / href="<prefix>....ext" to each
 * uploader's absolute URL, in place, so the saved page actually renders
 * those assets. Plain-text mentions outside an attribute are left
 * untouched.
 */
function rewriteOffloadedReferences(html: string, uploaders: OffloadUploader[]) {
  let out = html;
  for (const uploader of uploaders) {
    const base = uploader.baseUrl.endsWith("/") ? uploader.baseUrl : `${uploader.baseUrl}/`;
    const attrRe = new RegExp(
      `(\\b(?:src|href)\\s*=\\s*)(["'])(${uploader.prefix}\\d+\\.(?:${OFFLOAD_EXTENSIONS}))\\2`,
      "gi"
    );
    out = out.replace(attrRe, (_whole, prefix, quote, filename) => `${prefix}${quote}${base}${filename}${quote}`);
  }
  return out;
}

/**
 * Replace every quoted occurrence of any of several exact attribute values
 * with their corresponding new value, in a single pass over the HTML.
 * `valueMap`: Map<rawValue, newValue>.
 */
function replaceAttributeValues(html: string, valueMap: Map<string, string>) {
  const keys = [...valueMap.keys()];
  if (keys.length === 0) return html;
  const escaped = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(["'])(${escaped.join("|")})\\1`, "g");
  return html.replace(re, (_whole, quote, matched) => `${quote}${valueMap.get(matched)}${quote}`);
}

/**
 * Derive a safe, unique filename for an asset inside assets/, based on the
 * last path segment of its real URL. Falls back to a generic name and
 * de-duplicates against anything already used this run.
 */
function localFilenameFor(absoluteUrl: string, usedNames: Set<string>) {
  let base = "asset";
  try {
    base = decodeURIComponent(new URL(absoluteUrl).pathname.split("/").pop() || "asset");
  } catch (_e) {
    // keep default
  }
  base = base.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!base) base = "asset";

  let candidate = base;
  let n = 1;
  while (usedNames.has(candidate)) {
    const dot = base.lastIndexOf(".");
    candidate = dot > 0 ? `${base.slice(0, dot)}_${n}${base.slice(dot)}` : `${base}_${n}`;
    n++;
  }
  usedNames.add(candidate);
  return candidate;
}

interface AssetRef {
  raw: string;
  absolute: string;
}

interface FetchedAsset extends AssetRef {
  buffer: ArrayBuffer;
}

/**
 * Fetch a batch of {raw, absolute} URL pairs with limited concurrency.
 * `maxAssetBytes`, if set, skips embedding anything over that size —
 * checked via Content-Length first, then again after download as a
 * fallback for servers that omit that header.
 */
async function fetchAssets(refs: AssetRef[], userAgent: string, maxAssetBytes: number): Promise<FetchedAsset[]> {
  const results: FetchedAsset[] = [];
  let idx = 0;
  const concurrency = 6;

  async function worker() {
    while (idx < refs.length) {
      const i = idx++;
      const { raw, absolute } = refs[i];
      try {
        const res = await fetch(absolute, { headers: { "User-Agent": userAgent } });
        if (!res.ok) continue;
        if (maxAssetBytes) {
          const contentLength = parseInt(res.headers.get("content-length") || "", 10);
          if (Number.isFinite(contentLength) && contentLength > maxAssetBytes) continue;
        }
        const buffer = await res.arrayBuffer();
        if (maxAssetBytes && buffer.byteLength > maxAssetBytes) continue;
        results.push({ raw, absolute, buffer });
      } catch (_e) {
        // asset fetch failed — skip it, page will just show a broken image/video
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, refs.length) }, () => worker()));
  return results;
}

/**
 * Deflate `data` with no zlib/gzip wrapper — exactly the raw-deflate
 * stream format ZIP's "deflate" compression method (8) expects. Uses
 * Deno's built-in CompressionStream, so no extra dependency is needed.
 */
async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  writer.write(data);
  writer.close();

  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }

  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

// ---------- Minimal ZIP writer (store method, deflate for text entries) ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

// "Slicing-by-8": precompute 7 more tables so the main loop consumes 8
// bytes per iteration instead of 1. GitHub Actions runners give a full
// 2-core VM per job with no CPU-time metering, so this is even less of a
// concern than on a serverless platform — kept as-is since it's still
// cheap insurance on large multi-MB video buffers.
const CRC_TABLES = (() => {
  const tables = [CRC_TABLE];
  for (let t = 1; t < 8; t++) {
    const prev = tables[t - 1];
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      table[n] = (prev[n] >>> 8) ^ CRC_TABLE[prev[n] & 0xff];
    }
    tables.push(table);
  }
  return tables;
})();

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  const len = bytes.length;
  const end8 = len - (len % 8);
  const [T0, T1, T2, T3, T4, T5, T6, T7] = CRC_TABLES;
  let i = 0;
  for (; i < end8; i += 8) {
    const c0 = (bytes[i] ^ (crc & 0xff)) & 0xff;
    const c1 = (bytes[i + 1] ^ ((crc >>> 8) & 0xff)) & 0xff;
    const c2 = (bytes[i + 2] ^ ((crc >>> 16) & 0xff)) & 0xff;
    const c3 = (bytes[i + 3] ^ ((crc >>> 24) & 0xff)) & 0xff;
    crc =
      (T7[c0] ^
        T6[c1] ^
        T5[c2] ^
        T4[c3] ^
        T3[bytes[i + 4]] ^
        T2[bytes[i + 5]] ^
        T1[bytes[i + 6]] ^
        T0[bytes[i + 7]]) >>>
      0;
  }
  for (; i < len; i++) {
    crc = (T0[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getUTCFullYear());
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const dateVal = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, dateVal };
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
  /**
   * Deflate this entry (method 8) instead of storing it raw (method 0).
   * Only worth setting for text — index.html and any .txt attachments —
   * since images/video/audio are already compressed and deflating them
   * again just burns CPU for ~0 savings.
   */
  compress?: boolean;
}

/**
 * Build a standard ZIP archive from a list of entries. Entries flagged
 * `compress` are deflated (falling back to store if deflate somehow comes
 * out larger, e.g. for tiny inputs); everything else is stored as-is.
 * Returns a Uint8Array of the complete .zip file.
 */
async function buildZip(entries: ZipEntry[]) {
  const encoder = new TextEncoder();
  const { time, dateVal } = dosDateTime();

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const original = entry.data;
    const crc = crc32(original);

    let method = 0;
    let storedData = original;
    if (entry.compress) {
      const compressed = await deflateRaw(original);
      if (compressed.length < original.length) {
        method = 8;
        storedData = compressed;
      }
    }
    const compressedSize = storedData.length;
    const uncompressedSize = original.length;

    const localHeader = new DataView(new ArrayBuffer(30));
    localHeader.setUint32(0, 0x04034b50, true);
    localHeader.setUint16(4, 20, true);
    localHeader.setUint16(6, 0, true);
    localHeader.setUint16(8, method, true);
    localHeader.setUint16(10, time, true);
    localHeader.setUint16(12, dateVal, true);
    localHeader.setUint32(14, crc, true);
    localHeader.setUint32(18, compressedSize, true);
    localHeader.setUint32(22, uncompressedSize, true);
    localHeader.setUint16(26, nameBytes.length, true);
    localHeader.setUint16(28, 0, true);

    const localHeaderBytes = new Uint8Array(localHeader.buffer);
    localParts.push(localHeaderBytes, nameBytes, storedData);

    const centralHeader = new DataView(new ArrayBuffer(46));
    centralHeader.setUint32(0, 0x02014b50, true);
    centralHeader.setUint16(4, 20, true);
    centralHeader.setUint16(6, 20, true);
    centralHeader.setUint16(8, 0, true);
    centralHeader.setUint16(10, method, true);
    centralHeader.setUint16(12, time, true);
    centralHeader.setUint16(14, dateVal, true);
    centralHeader.setUint32(16, crc, true);
    centralHeader.setUint32(20, compressedSize, true);
    centralHeader.setUint32(24, uncompressedSize, true);
    centralHeader.setUint16(28, nameBytes.length, true);
    centralHeader.setUint16(30, 0, true);
    centralHeader.setUint16(32, 0, true);
    centralHeader.setUint16(34, 0, true);
    centralHeader.setUint16(36, 0, true);
    centralHeader.setUint32(38, 0, true);
    centralHeader.setUint32(42, offset, true);

    centralParts.push(new Uint8Array(centralHeader.buffer), nameBytes);

    offset += localHeaderBytes.length + nameBytes.length + storedData.length;
  }

  const centralDirOffset = offset;
  const centralDirSize = centralParts.reduce((sum, p) => sum + p.length, 0);

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralDirSize, true);
  eocd.setUint32(16, centralDirOffset, true);
  eocd.setUint16(20, 0, true);

  const allParts = [...localParts, ...centralParts, new Uint8Array(eocd.buffer)];
  const totalSize = allParts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalSize);
  let pos = 0;
  for (const part of allParts) {
    result.set(part, pos);
    pos += part.length;
  }
  return result;
}

// ---------- GitHub Releases upload (replaces R2) ----------
//
// Runs inside the GitHub Actions job itself, so it uses the job's
// auto-issued token (GITHUB_TOKEN — set as an env var by the workflow
// YAML from ${{ secrets.GITHUB_TOKEN }}, NOT a manually created PAT)
// rather than a personal access token. The workflow needs
// `permissions: contents: write` for this token to be allowed to create
// releases / upload assets.
//
// One release per board (tag = boardSlug), one asset per thread
// (<threadId>.zip). Re-archiving a thread with more replies means
// deleting the old asset first — GitHub rejects uploading an asset name
// that already exists on a release rather than overwriting it, unlike
// R2's PUT-by-key which just silently replaced the object.

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function boardSlug(boardHost: string, boardPath: string): string {
  return `${boardHost}${boardPath}`.replace(/[^a-z0-9]+/gi, "_");
}

function ghHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...extra,
  };
}

interface GhRelease {
  id: number;
  upload_url: string; // templated, e.g. ".../assets{?name,label}"
}

interface GhAsset {
  id: number;
  name: string;
}

/** GET the release for this board's tag, creating it on first use. */
async function getOrCreateRelease(owner: string, repo: string, tag: string, token: string): Promise<GhRelease> {
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const getRes = await fetch(`${base}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: ghHeaders(token),
  });
  if (getRes.ok) return await getRes.json();
  if (getRes.status !== 404) {
    throw new Error(`GET release tag ${tag} failed: ${getRes.status} ${await getRes.text().catch(() => "")}`);
  }

  const createRes = await fetch(`${base}/releases`, {
    method: "POST",
    headers: ghHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      tag_name: tag,
      name: tag,
      body: `Archived Futaba threads for ${tag}`,
      draft: false,
      prerelease: false,
    }),
  });
  if (!createRes.ok) {
    throw new Error(`create release ${tag} failed: ${createRes.status} ${await createRes.text().catch(() => "")}`);
  }
  return await createRes.json();
}

/**
 * List every asset on a release (paginated — the release-by-tag
 * response's embedded .assets field isn't reliably complete once a
 * release has many assets, so this pages the dedicated assets endpoint
 * instead of trusting that field).
 */
async function listReleaseAssets(owner: string, repo: string, releaseId: number, token: string): Promise<GhAsset[]> {
  const assets: GhAsset[] = [];
  let page = 1;
  for (;;) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets?per_page=100&page=${page}`,
      { headers: ghHeaders(token) }
    );
    if (!res.ok) throw new Error(`list assets failed: ${res.status} ${await res.text().catch(() => "")}`);
    const batch: GhAsset[] = await res.json();
    assets.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return assets;
}

async function deleteReleaseAsset(owner: string, repo: string, assetId: number, token: string): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${assetId}`, {
    method: "DELETE",
    headers: ghHeaders(token),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`delete asset ${assetId} failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
}

/** Upload the zip, replacing any existing same-named asset on this release. */
async function uploadReleaseAsset(
  owner: string,
  repo: string,
  release: GhRelease,
  assetName: string,
  data: Uint8Array,
  token: string
): Promise<{ id: number; browserDownloadUrl: string }> {
  const existing = await listReleaseAssets(owner, repo, release.id, token);
  const dupe = existing.find((a) => a.name === assetName);
  if (dupe) await deleteReleaseAsset(owner, repo, dupe.id, token);

  const uploadUrl = release.upload_url.replace(/\{.*\}$/, `?name=${encodeURIComponent(assetName)}`);
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: ghHeaders(token, { "Content-Type": "application/zip" }),
    body: data,
  });
  if (!res.ok) {
    throw new Error(`upload asset ${assetName} failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const json = await res.json();
  return { id: json.id, browserDownloadUrl: json.browser_download_url };
}

// ---------- Core per-thread archive logic ----------

interface ArchiveRequest {
  threadId: string;
  boardHost: string;
  boardPath: string;
  userAgent?: string;
  maxAssetsPerThread?: number;
  maxAssetBytes?: number;
  offloadUploaders?: OffloadUploader[];
}

async function archiveThread(req: ArchiveRequest) {
  const {
    threadId,
    boardHost,
    boardPath,
    userAgent = "FutabaThreadArchiver/1.0 (personal archive)",
    maxAssetsPerThread = 40,
    maxAssetBytes = 0,
    offloadUploaders = [],
  } = req;

  const pageUrl = `https://${boardHost}${boardPath}res/${threadId}.htm`;

  const res = await fetch(pageUrl, { headers: { "User-Agent": userAgent } });
  if (!res.ok) {
    return { ok: false, reason: `thread fetch failed: ${res.status}` };
  }
  const buffer = await res.arrayBuffer();
  const { text: rawHtml } = decodeBuffer(buffer, res.headers.get("content-type"));

  // Fetch bare "<prefix>NNNN.ext" mentions too (including ones only in
  // plain post text), for every uploader the Deno service told us about.
  const offloadedUrls = extractOffloadedAssetUrls(rawHtml, offloadUploaders);

  // Resolve bare filenames appearing in src/href to their real absolute
  // offload URL, and fix the charset declaration to match the UTF-8 bytes
  // we're about to write.
  let html = rewriteOffloadedReferences(rawHtml, offloadUploaders);
  html = forceUtf8Meta(html);

  // Thumbnails paired with a full-size <a href> are dropped from the
  // outbound fetch list entirely — only the full-size original is fetched.
  const thumbToFull = extractLinkedThumbnails(html);

  const stylesheetUrls = extractStylesheetUrls(html);

  const rawAssetRefs = extractAssetUrls(html).filter((url) => !thumbToFull.has(url));
  const allRawRefs = [...new Set([...rawAssetRefs, ...offloadedUrls])];

  const refs: AssetRef[] = [];
  for (const raw of allRawRefs.slice(0, maxAssetsPerThread)) {
    try {
      refs.push({ raw, absolute: new URL(raw, pageUrl).toString() });
    } catch (_e) {
      // unparseable URL, skip
    }
  }

  const fetched = await fetchAssets(refs, userAgent, maxAssetBytes);

  const usedNames = new Set<string>();
  const zipEntries: ZipEntry[] = [];
  const valueMap = new Map<string, string>();
  for (const asset of fetched) {
    const localName = localFilenameFor(asset.absolute, usedNames);
    valueMap.set(asset.raw, `assets/${localName}`);
    zipEntries.push({
      name: `assets/${localName}`,
      data: new Uint8Array(asset.buffer),
      compress: /\.txt$/i.test(localName) || stylesheetUrls.has(asset.raw),
    });
  }
  // Point each skipped thumbnail at the same local asset as the full-size
  // image it was paired with, so the saved <img> tag still renders.
  for (const [thumb, full] of thumbToFull) {
    const mapped = valueMap.get(full);
    if (mapped) valueMap.set(thumb, mapped);
  }
  html = replaceAttributeValues(html, valueMap);

  zipEntries.unshift({ name: "index.html", data: new TextEncoder().encode(html), compress: true });

  const zipBytes = await buildZip(zipEntries);

  // ---- was: R2 PUT via aws4fetch; now: GitHub Release asset upload ----
  const token = requireEnv("GITHUB_TOKEN");
  const [owner, repo] = requireEnv("GITHUB_REPOSITORY").split("/"); // auto-set by every Actions runner
  const tag = boardSlug(boardHost, boardPath);
  const assetName = `${threadId}.zip`;

  const release = await getOrCreateRelease(owner, repo, tag, token);
  const { browserDownloadUrl } = await uploadReleaseAsset(owner, repo, release, assetName, zipBytes, token);

  return {
    ok: true,
    key: `${tag}/${assetName}`, // kept as "key" for callback-shape compatibility with deno-service/catalog.ts
    assetUrl: browserDownloadUrl,
    assetCount: fetched.length,
  };
}

// ---------- Entry point ----------

interface JobPayload extends ArchiveRequest {
  replies?: number;
  callbackUrl?: string;
}

function readPayload(): JobPayload {
  const raw = Deno.env.get("PAYLOAD_JSON");
  if (!raw) {
    throw new Error("Missing PAYLOAD_JSON environment variable");
  }
  let parsed: JobPayload;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`PAYLOAD_JSON is not valid JSON: ${e}`);
  }
  if (!parsed.threadId || !parsed.boardHost || !parsed.boardPath) {
    throw new Error("PAYLOAD_JSON missing required fields: threadId, boardHost, boardPath");
  }
  return parsed;
}

/**
 * Report the outcome back to the Deno service so it can update its
 * archived/pending state (now stored in this repo — see
 * deno-service/catalog.ts's GitHub-backed state helpers). Best-effort:
 * if this fails, the job still exits with the correct status code so the
 * Actions run itself shows success/failure, but the Deno service's state
 * won't be updated until the thread is re-picked-up (it'll fall out of
 * "pending" after PENDING_TIMEOUT_MS on that side and get retried on a
 * later catalog pass).
 */
async function sendCallback(callbackUrl: string, payload: Record<string, unknown>) {
  const secret = Deno.env.get("CALLBACK_SECRET");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["Authorization"] = `Bearer ${secret}`;

  try {
    const res = await fetch(callbackUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`callback POST to ${callbackUrl} failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
  } catch (e) {
    console.error(`callback POST to ${callbackUrl} threw: ${e}`);
  }
}

async function main() {
  const payload = readPayload();
  const { threadId, boardHost, boardPath, replies, callbackUrl } = payload;

  let result: { ok: boolean; reason?: string; key?: string; assetUrl?: string; assetCount?: number };
  try {
    result = await archiveThread(payload);
  } catch (e) {
    result = { ok: false, reason: String(e) };
  }

  console.log(JSON.stringify({ threadId, boardHost, boardPath, ...result }));

  if (callbackUrl) {
    await sendCallback(callbackUrl, { threadId, boardHost, boardPath, replies, ...result });
  } else {
    console.error("No callbackUrl in payload — Deno service state will not be updated for this thread.");
  }

  // Non-zero exit on failure so the Actions run itself is visibly red in
  // the GitHub UI, independent of whether the callback succeeded.
  Deno.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`Unhandled error in main(): ${e}`);
  Deno.exit(1);
});
