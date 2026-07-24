/**
 * Futaba Channel thread archiver — Deno Deploy half.
 *
 * This service does the CPU-heavy per-thread work that used to risk the
 * Cloudflare Workers Free plan's 10ms CPU cap:
 *   1. Fetch one thread's HTML page.
 *   2. Fetch every image/video/css/txt it references, including assets
 *      Futaba/2chan offload to separate upload servers and refer to only
 *      by a bare filename (e.g. "fu6988461.jpg", "f3204512.png") — which
 *      uploader/prefix combos exist is entirely driven by the
 *      `offloadUploaders` list passed in each request, so this file
 *      doesn't need to know Futaba's specific conventions or be edited
 *      when the Worker's board config adds a new uploader.
 *   3. Rewrite the HTML so every asset reference points at
 *      assets/<filename>, pack it all into a .zip (CRC32'd, store method),
 *      and PUT that zip straight into R2 using R2's S3-compatible API
 *      (via aws4fetch) — no Cloudflare Worker in the loop for this part.
 *
 * The Cloudflare Worker (cf-worker/index.js) still owns board config,
 * catalog polling, R2-backed state blobs, and the Internet Archive sync.
 * It calls this service's POST /archive endpoint once per thread that
 * needs archiving and just awaits the result.
 *
 * OUTBOUND TRAFFIC BUDGET + RENDER FALLOVER
 * ------------------------------------------
 * This same file is meant to run in two places:
 *   - Deno Deploy (primary), where OUTBOUND_LIMIT_GBITS is set.
 *   - Render (fallback twin), via the Dockerfile in render/, where
 *     OUTBOUND_LIMIT_GBITS is left UNSET.
 *
 * On the Deno Deploy instance, every request tallies how many bytes it
 * moved (thread page + assets fetched in, zip bytes pushed out to R2)
 * into a Deno KV counter for the current UTC calendar day. Once that
 * running total reaches OUTBOUND_LIMIT_GBITS worth of traffic, this
 * instance stops doing the work itself for the rest of the day and
 * instead forwards each /archive request verbatim to RENDER_ARCHIVE_URL
 * — a second deployment of this exact file, running on Render, which
 * never hits this check because it has no OUTBOUND_LIMIT_GBITS configured
 * and just processes the request directly. The Cloudflare Worker never
 * needs to know any of this happened; it always calls DENO_ARCHIVE_URL
 * and gets back the same `{ ok, key, assetCount, ... }` shape either way
 * (the forwarded response is tagged `viaRender: true` for observability).
 *
 * Required environment variables (Deno Deploy project settings):
 *   R2_ACCOUNT_ID        — your Cloudflare account ID
 *   R2_ACCESS_KEY_ID     — from an R2 API token (dashboard: R2 > Manage
 *                          R2 API Tokens > create with Object Read & Write)
 *   R2_SECRET_ACCESS_KEY — the matching secret
 *   R2_BUCKET_NAME       — the same bucket your Worker's ARCHIVE_BUCKET
 *                          binding points at
 *   SHARED_SECRET        — (optional but recommended) must match
 *                          DENO_SHARED_SECRET in the Worker; requests
 *                          without a matching `Authorization: Bearer ...`
 *                          header are rejected
 *
 * Optional, traffic-budget-related environment variables:
 *   OUTBOUND_LIMIT_GBITS — set ONLY on the Deno Deploy instance. Total
 *                          traffic (decimal gigabits) this instance will
 *                          move per UTC calendar day before it starts
 *                          forwarding requests to Render instead. Resets
 *                          at UTC midnight. Leave unset to disable the
 *                          budget/fallover entirely (default behavior,
 *                          unchanged from before).
 *                          Example: "2" = 2 Gbit = 250,000,000 bytes/day.
 *   RENDER_ARCHIVE_URL   — e.g. https://your-app.onrender.com/archive.
 *                          Where requests get forwarded once the budget
 *                          above is exhausted. Required if
 *                          OUTBOUND_LIMIT_GBITS is set; ignored otherwise.
 *   RENDER_SHARED_SECRET — (optional but recommended) sent as
 *                          `Authorization: Bearer ...` to the Render
 *                          twin; should match that deployment's own
 *                          SHARED_SECRET.
 *   FORCE_RENDER_FALLBACK — set to "true" to force every /archive request
 *                          on this Deno instance to forward to Render,
 *                          regardless of the traffic counter. For testing
 *                          the Render twin on demand without needing to
 *                          actually burn through a day's budget first.
 *                          Any value other than "true" (including unset)
 *                          is treated as normal (budget-driven) behavior.
 *
 * Everything board-specific (host/path, offload uploader prefixes/base
 * URLs, user agent, per-run asset caps) is passed in per-request by the
 * Worker, since it already owns that configuration — no duplication here.
 */

import { AwsClient } from "https://esm.sh/aws4fetch@1.0.20";

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
 * Every thread on a board shares the exact same stylesheet. When a Deno
 * isolate stays warm across several /archive calls in a row (e.g. the
 * Worker archiving a batch of bumped threads back-to-back), there's no
 * reason to re-fetch that identical CSS file over the network for every
 * thread after the first — same idea as skipping a thumbnail in favor of
 * an asset that's already being fetched anyway. This cache is scoped to
 * the isolate only: a cold start, or a different isolate, just fetches
 * the CSS fresh once and populates its own copy of the cache.
 */
const cssAssetCache = new Map<string, ArrayBuffer>();

// ---------- Offload uploaders (generic — config comes from the request) ----------

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
 * the Worker sent in this request — this function has no built-in
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
// bytes per iteration instead of 1. No CPU cap to worry about on Deno
// Deploy the way there was on Workers Free, but this is still cheap
// insurance on large multi-MB video buffers.
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

// ---------- R2 upload (S3-compatible API, direct from Deno) ----------

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

/** PUT an object straight into R2 via its S3-compatible endpoint. */
async function putToR2(key: string, body: Uint8Array, contentType: string) {
  const accountId = requireEnv("R2_ACCOUNT_ID");
  const bucket = requireEnv("R2_BUCKET_NAME");
  // Encode each path segment but keep the "/" separators the key relies on.
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const url = `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${encodedKey}`;

  const client = getR2Client();
  const res = await client.fetch(url, {
    method: "PUT",
    body,
    headers: { "Content-Type": contentType },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`R2 PUT failed (${res.status}): ${text.slice(0, 500)}`);
  }
}

// ---------- Outbound traffic budget (Deno KV) + Render fallover ----------
//
// See the file-level doc comment above for the full picture. Short
// version: this instance tallies bytes moved per request into a Deno KV
// counter keyed by UTC calendar day. Once the running total for today
// reaches OUTBOUND_LIMIT_GBITS, this instance forwards every subsequent
// /archive request to RENDER_ARCHIVE_URL instead of doing the work
// itself, until the counter resets at UTC midnight.
//
// Tracking is entirely opt-in: if OUTBOUND_LIMIT_GBITS isn't set (e.g. on
// the Render twin itself), Deno.openKv() is never even called, so this
// adds no overhead or extra permissions requirement to that deployment.
//
// FORCE_RENDER_FALLBACK="true" bypasses the counter check entirely and
// always forwards to Render — a manual on/off switch for testing the
// Render twin without waiting to actually burn through a day's budget.

/**
 * Total budget in bytes for the current UTC day, or null if traffic
 * tracking/fallover is disabled (OUTBOUND_LIMIT_GBITS not set).
 *
 * Uses *decimal* gigabits, matching how network bandwidth is normally
 * advertised: 1 Gbit = 1,000,000,000 bits = 125,000,000 bytes.
 */
function outboundLimitBytes(): number | null {
  const raw = Deno.env.get("OUTBOUND_LIMIT_GBITS");
  if (!raw) return null;
  const gbits = parseFloat(raw);
  if (!Number.isFinite(gbits) || gbits <= 0) return null;
  return (gbits * 1_000_000_000) / 8;
}

/** Manual test override — forces every request onto the Render twin. */
function forceRenderFallback(): boolean {
  return (Deno.env.get("FORCE_RENDER_FALLBACK") || "").toLowerCase() === "true";
}

function currentDayKey(): string {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${now.getUTCFullYear()}-${month}-${day}`;
}

let kv: Deno.Kv | null = null;

/** Lazily opens Deno KV, but only if traffic tracking is actually enabled. */
async function getKv(): Promise<Deno.Kv | null> {
  if (outboundLimitBytes() === null) return null;
  if (kv) return kv;
  try {
    kv = await Deno.openKv();
    return kv;
  } catch (e) {
    console.error("Deno.openKv() failed — traffic tracking disabled for this run:", e);
    return null;
  }
}

/** Bytes moved so far today (UTC), or 0 if tracking is unavailable. */
async function getDailyTrafficBytes(): Promise<number> {
  const store = await getKv();
  if (!store) return 0;
  const entry = await store.get<Deno.KvU64>(["outbound_bytes", currentDayKey()]);
  return entry.value ? Number(entry.value.value) : 0;
}

/** Atomically add to today's traffic counter. Never throws. */
async function addDailyTrafficBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const store = await getKv();
  if (!store) return;
  try {
    await store
      .atomic()
      .mutate({
        type: "sum",
        key: ["outbound_bytes", currentDayKey()],
        value: new Deno.KvU64(BigInt(Math.round(bytes))),
      })
      .commit();
  } catch (e) {
    console.error("failed to record outbound traffic in KV:", e);
  }
}

/**
 * Forward an /archive request verbatim to the Render twin. Returns the
 * same `{ ok, key, assetCount, ... }` shape the Worker already expects,
 * tagged with `viaRender: true` so it's visible in logs/results which
 * path handled a given thread.
 */
async function forwardToRender(req: ArchiveRequest): Promise<Record<string, unknown>> {
  const renderUrl = Deno.env.get("RENDER_ARCHIVE_URL");
  if (!renderUrl) {
    return {
      ok: false,
      reason: "outbound traffic limit reached for today (or FORCE_RENDER_FALLBACK is set) and RENDER_ARCHIVE_URL is not configured",
    };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const renderSecret = Deno.env.get("RENDER_SHARED_SECRET");
  if (renderSecret) headers["Authorization"] = `Bearer ${renderSecret}`;

  let res: Response;
  try {
    res = await fetch(renderUrl, { method: "POST", headers, body: JSON.stringify(req) });
  } catch (e) {
    return { ok: false, reason: `Render archive request failed: ${e}` };
  }

  let json: Record<string, unknown>;
  try {
    json = await res.json();
  } catch (_e) {
    const text = await res.text().catch(() => "");
    return { ok: false, reason: `Render archive returned non-JSON (status ${res.status}): ${text.slice(0, 300)}` };
  }

  if (!res.ok && json.ok !== true) {
    return { ok: false, status: res.status, reason: json.reason ?? `Render archive call failed: ${res.status}`, viaRender: true };
  }

  return { ...json, viaRender: true };
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

  // Tallies every byte this run moves over the network — thread page +
  // assets fetched in, zip bytes pushed out to R2 — so the caller can add
  // it to the daily outbound-traffic counter above. Cached CSS (served
  // from cssAssetCache without a network request) intentionally doesn't
  // count here since no traffic was actually moved for it.
  let bytesMoved = 0;

  const pageUrl = `https://${boardHost}${boardPath}res/${threadId}.htm`;

  const res = await fetch(pageUrl, { headers: { "User-Agent": userAgent } });
  if (!res.ok) {
    return { ok: false, reason: `thread fetch failed: ${res.status}`, bytesMoved };
  }
  const buffer = await res.arrayBuffer();
  bytesMoved += buffer.byteLength;
  const { text: rawHtml } = decodeBuffer(buffer, res.headers.get("content-type"));

  // Fetch bare "<prefix>NNNN.ext" mentions too (including ones only in
  // plain post text), for every uploader the Worker told us about.
  const offloadedUrls = extractOffloadedAssetUrls(rawHtml, offloadUploaders);

  // Resolve bare filenames appearing in src/href to their real absolute
  // offload URL, and fix the charset declaration to match the UTF-8 bytes
  // we're about to write.
  let html = rewriteOffloadedReferences(rawHtml, offloadUploaders);
  html = forceUtf8Meta(html);

  // Thumbnails paired with a full-size <a href> are dropped from the
  // outbound fetch list entirely — only the full-size original is fetched.
  const thumbToFull = extractLinkedThumbnails(html);

  // Stylesheets are handled like thumbnails: identified up front and, when
  // possible, kept off the network entirely rather than fetched fresh.
  const stylesheetUrls = extractStylesheetUrls(html);

  const rawAssetRefs = extractAssetUrls(html).filter((url) => !thumbToFull.has(url));
  const allRawRefs = [...new Set([...rawAssetRefs, ...offloadedUrls])];

  const refs: AssetRef[] = [];
  const cachedAssets: FetchedAsset[] = [];
  for (const raw of allRawRefs.slice(0, maxAssetsPerThread)) {
    let absolute: string;
    try {
      absolute = new URL(raw, pageUrl).toString();
    } catch (_e) {
      continue; // unparseable URL, skip
    }
    const cachedCss = stylesheetUrls.has(raw) ? cssAssetCache.get(absolute) : undefined;
    if (cachedCss) {
      cachedAssets.push({ raw, absolute, buffer: cachedCss });
      continue;
    }
    refs.push({ raw, absolute });
  }

  const fetched = await fetchAssets(refs, userAgent, maxAssetBytes);
  for (const asset of fetched) {
    bytesMoved += asset.buffer.byteLength;
  }

  // Seed the warm-instance cache with any CSS fetched just now, so later
  // /archive calls in this same isolate (other threads on the same board)
  // can skip fetching it over the network at all.
  for (const asset of fetched) {
    if (stylesheetUrls.has(asset.raw)) {
      cssAssetCache.set(asset.absolute, asset.buffer);
    }
  }

  const allFetched = [...fetched, ...cachedAssets];

  const usedNames = new Set<string>();
  const zipEntries: ZipEntry[] = [];
  const valueMap = new Map<string, string>();
  for (const asset of allFetched) {
    const localName = localFilenameFor(asset.absolute, usedNames);
    valueMap.set(asset.raw, `assets/${localName}`);
    zipEntries.push({
      name: `assets/${localName}`,
      data: new Uint8Array(asset.buffer),
      compress: /\.txt$/i.test(localName),
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
  bytesMoved += zipBytes.length; // this is what actually goes out over the wire to R2

  const key = `${boardHost}${boardPath}${threadId}.zip`.replace(/\/+/g, "/");
  await putToR2(key, zipBytes, "application/zip");

  return {
    ok: true,
    key,
    assetCount: allFetched.length,
    assetsFetched: fetched.length,
    assetsFromCache: cachedAssets.length,
    bytesMoved,
  };
}

// ---------- HTTP handler ----------

Deno.serve({ port: Number(Deno.env.get("PORT")) || 8000 }, async (request: Request) => {
  const url = new URL(request.url);

  if (url.pathname === "/status" && request.method === "GET") {
    const limitBytes = outboundLimitBytes();
    const usedBytes = await getDailyTrafficBytes();
    return Response.json({
      day: currentDayKey(),
      trafficTrackingEnabled: limitBytes !== null,
      usedBytes,
      limitBytes,
      overLimit: limitBytes !== null && usedBytes >= limitBytes,
      forceRenderFallback: forceRenderFallback(),
      renderConfigured: Boolean(Deno.env.get("RENDER_ARCHIVE_URL")),
    });
  }

  if (url.pathname !== "/archive" || request.method !== "POST") {
    return new Response(
      "Futaba archiver (Deno worker). POST /archive with a JSON body: { threadId, boardHost, boardPath, userAgent?, maxAssetsPerThread?, maxAssetBytes?, offloadUploaders?: [{ prefix, baseUrl }] }",
      { status: request.method === "GET" && url.pathname === "/" ? 200 : 404 }
    );
  }

  const sharedSecret = Deno.env.get("SHARED_SECRET");
  if (sharedSecret) {
    const auth = request.headers.get("authorization") || "";
    if (auth !== `Bearer ${sharedSecret}`) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let body: ArchiveRequest;
  try {
    body = await request.json();
  } catch (_e) {
    return Response.json({ ok: false, reason: "invalid JSON body" }, { status: 400 });
  }

  if (!body.threadId || !body.boardHost || !body.boardPath) {
    return Response.json(
      { ok: false, reason: "missing required fields: threadId, boardHost, boardPath" },
      { status: 400 }
    );
  }

  // FORCE_RENDER_FALLBACK="true" is a manual override for testing the
  // Render twin on demand, bypassing the traffic counter entirely.
  if (forceRenderFallback()) {
    const result = await forwardToRender(body);
    return Response.json(result, { status: result.ok ? 200 : 502 });
  }

  // Otherwise, if this instance has a configured daily budget and it's
  // already exhausted, skip doing the work locally and hand the whole
  // request to the Render twin instead.
  const limitBytes = outboundLimitBytes();
  if (limitBytes !== null) {
    const usedBytes = await getDailyTrafficBytes();
    if (usedBytes >= limitBytes) {
      const result = await forwardToRender(body);
      return Response.json(result, { status: result.ok ? 200 : 502 });
    }
  }

  try {
    const result = await archiveThread(body);
    if (typeof result.bytesMoved === "number") {
      await addDailyTrafficBytes(result.bytesMoved);
    }
    return Response.json(result, { status: result.ok ? 200 : 502 });
  } catch (e) {
    return Response.json({ ok: false, reason: String(e) }, { status: 500 });
  }
});
