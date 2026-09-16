/**
 * Thin TeraBox-backed storage helper, shared by catalog.ts,
 * archive-thread.ts, and sync-terabox-to-ia.ts. Mirrors the shape of the
 * old R2 helpers (getObject/putObject/getJSON/putJSON/deleteObject/
 * listDir) so callers didn't need much restructuring when this project
 * moved off Cloudflare R2 onto TeraBox.
 *
 * AUTH: a single long-lived TeraBox session cookie (the `ndus` value),
 * read from TERABOX_NDUS. No username/password login flow is used —
 * TeraBoxApp's constructor accepts the ndus token directly. This token
 * does eventually expire; when calls here start failing consistently,
 * grab a fresh `ndus` cookie value from a logged-in browser session and
 * rotate the TERABOX_NDUS secret.
 *
 * FILESYSTEM DEPENDENCY: hashFile()/uploadChunks() from terabox-api's
 * helper module stream from a real file path, not a buffer, so putObject
 * below writes the payload to a temp file first. This requires actual
 * file system write access — confirmed available on the NEW Deno Deploy
 * platform (console.deno.com), NOT on the now-shut-down Deploy Classic
 * (dash.deno.com), which only ever exposed read-only fs APIs for static
 * repo files.
 */

import { TeraBoxApp } from "npm:terabox-api@2.8.0";
import { hashFile, uploadChunks, unwrapErrorMessage } from "npm:terabox-api@2.8.0/helper";

// All archive/state paths live under this root so they don't collide
// with anything else already in the account's TeraBox.
const ROOT = (Deno.env.get("TERABOX_ROOT_DIR") ?? "/futaba-archive").replace(/\/+$/, "");

let client: InstanceType<typeof TeraBoxApp> | null = null;

function getClient(): InstanceType<typeof TeraBoxApp> | null {
  const ndus = Deno.env.get("TERABOX_NDUS");
  if (!ndus) return null; // not configured — every caller below fails open on this
  if (!client) client = new TeraBoxApp(ndus, "ndus");
  return client;
}

function splitPath(fullPath: string): { dir: string; file: string } {
  const idx = fullPath.lastIndexOf("/");
  return { dir: fullPath.slice(0, idx) || "/", file: fullPath.slice(idx + 1) };
}

/** Absolute TeraBox path for an R2-style relative key, e.g. "board/thread.zip" -> "/futaba-archive/board/thread.zip". */
export function pathFor(key: string): string {
  return `${ROOT}/${key}`.replace(/\/+/g, "/");
}

/** Fail-open: unconfigured client or not-found file both return null, never throw. */
export async function getObject(fullPath: string): Promise<Uint8Array | null> {
  const app = getClient();
  if (!app) return null;
  const { dir, file } = splitPath(fullPath);

  try {
    const listing = await app.getRemoteDir(dir);
    if (listing.errno !== 0 || !Array.isArray(listing.list)) return null;
    const entry = listing.list.find((e: any) => e.server_filename === file);
    if (!entry) return null;

    const dl = await app.download([entry.fs_id]);
    const dlink = dl?.dlink?.[0];
    if (!dlink) return null;

    const res = await fetch(dlink, { headers: { "User-Agent": app.params.ua } });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    console.error(`terabox getObject ${fullPath} failed:`, unwrapErrorMessage(e));
    return null;
  }
}

export async function getJSON(fullPath: string): Promise<any | null> {
  const bytes = await getObject(fullPath);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Uploads `body` to `fullPath` via TeraBox's precreate -> hash -> chunk
 * upload -> create flow, using terabox-api's own hashFile/uploadChunks
 * orchestration (concurrency + retry + MD5 verification handled inside
 * those functions — see helper.js). No-op if TERABOX_NDUS isn't set,
 * mirroring the old "R2 not configured" fail-open behavior.
 */
export async function putObject(fullPath: string, body: Uint8Array): Promise<void> {
  const app = getClient();
  if (!app) return;
  const { dir, file } = splitPath(fullPath);

  const tmpPath = await Deno.makeTempFile({ prefix: "tb-put-" });
  try {
    await Deno.writeFile(tmpPath, body);
    const hash = await hashFile(tmpPath);
    const data: any = {
      remote_dir: dir,
      file,
      size: body.length,
      hash,
      uploaded: new Array(hash.chunks.length).fill(false),
    };

    const pre = await app.precreateFile(data);
    if (pre.errno !== 0 || !pre.uploadid) {
      throw new Error(`precreate failed: errno ${pre.errno}`);
    }
    data.upload_id = pre.uploadid;

    await app.getUploadHost();

    const up = await uploadChunks(app, data, tmpPath, 6, 5);
    if (!up.ok) throw new Error("chunk upload failed after retries");

    const created = await app.createFile(data);
    if (created.errno && created.errno !== 0) {
      throw new Error(`create failed: errno ${created.errno}`);
    }
  } finally {
    await Deno.remove(tmpPath).catch(() => {});
  }
}

export async function putJSON(fullPath: string, value: unknown): Promise<void> {
  await putObject(fullPath, new TextEncoder().encode(JSON.stringify(value)));
}

export async function deleteObject(fullPath: string): Promise<void> {
  const app = getClient();
  if (!app) return;
  try {
    await app.filemanager("delete", [fullPath]);
  } catch (e) {
    console.error(`terabox deleteObject ${fullPath} failed:`, unwrapErrorMessage(e));
  }
}

/** Lists files directly under `dir` (non-recursive — matches the old R2 list({prefix}) usage across this project). */
export async function listDir(dir: string): Promise<Array<{ path: string; size: number; fs_id: number }>> {
  const app = getClient();
  if (!app) return [];
  try {
    const listing = await app.getRemoteDir(dir);
    if (listing.errno !== 0 || !Array.isArray(listing.list)) return [];
    return listing.list
      .filter((e: any) => e.isdir === 0)
      .map((e: any) => ({ path: e.path, size: e.size, fs_id: e.fs_id }));
  } catch (e) {
    console.error(`terabox listDir ${dir} failed:`, unwrapErrorMessage(e));
    return [];
  }
}
