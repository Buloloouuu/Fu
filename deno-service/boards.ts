/**
 * Shared board configuration + state-key helpers.
 *
 * Split out from catalog.ts so sync-terabox-to-ia.ts (a standalone CLI
 * script, run once per Action) can reuse the same board list and key
 * derivation without importing catalog.ts itself — that file has
 * top-level Deno.serve()/Deno.cron() side effects that must never fire
 * inside a one-shot script.
 *
 * Both NATIVE_CRON_BOARDS (scheduled via Deno.cron() in catalog.ts) and
 * GET_CRON_BOARDS (scheduled externally, via catalog.ts's GET /run) live
 * here as one single source of truth — no more duplication across a
 * Worker file and a Deno file, since cf-worker/ has been deleted.
 *
 * Boards intentionally left out of both tiers (not a `.../futaba.htm`
 * catalog page, or no concrete board path was available to derive one):
 * www.2chan.net/script/ (a tools page, not a board), jun.2chan.net/ascii/
 * (different page — index2.html, not futaba.htm), dec.2chan.net/up/ and
 * /up2/ (uploader utility pages, not boards), the "2D Guro" and "Erotic
 * Games (Eroge)" entries (both link only to an age-gate page —
 * /en/guro2-enter.html / /en/enter.html — with no board path behind it
 * visible from the source listing), and "Figures" (commented out in the
 * site's own board list, i.e. currently disabled there).
 */

export type Board = { host: string; path: string; cron?: string };

export const NATIVE_CRON_BOARDS: Board[] = [
  {
    host: Deno.env.get("BOARD_HOST") ?? "",
    path: Deno.env.get("BOARD_PATH") ?? "",
    cron: Deno.env.get("ARCHIVE_CRON") ?? "*/5 * * * *",
  },
  { host: "may.2chan.net", path: "/b/", cron: "*/6 * * * *" },
  { host: "jun.2chan.net", path: "/jun/", cron: "*/16 * * * *" },
  { host: "dec.2chan.net", path: "/dec/", cron: "*/18 * * * *" },
];

// No `cron` field on purpose. These are scheduled entirely externally —
// point a third-party "hit a URL on a schedule" cron service at
// catalog.ts's own GET /run?host=&path=&token=... endpoint, one schedule
// per board. GET /get-cron-boards on that service returns ready-to-paste
// URLs for this whole list.
export const GET_CRON_BOARDS: Board[] = [
  { host: "dec.2chan.net", path: "/84/" }, // Hololive
  { host: "www.2chan.net", path: "/hinan/" }, // Refuge
  { host: "zip.2chan.net", path: "/1/" }, // Baseball
  { host: "zip.2chan.net", path: "/12/" }, // Soccer
  { host: "may.2chan.net", path: "/25/" }, // Mahjong
  { host: "may.2chan.net", path: "/26/" }, // Horse Racing
  { host: "may.2chan.net", path: "/27/" }, // Cats
  { host: "dat.2chan.net", path: "/d/" }, // Animals
  { host: "zip.2chan.net", path: "/z/" }, // Plants
  { host: "dat.2chan.net", path: "/w/" }, // Insects
  { host: "dat.2chan.net", path: "/49/" }, // Aquariums
  { host: "dec.2chan.net", path: "/62/" }, // Outdoors
  { host: "dat.2chan.net", path: "/t/" }, // Cooking
  { host: "dat.2chan.net", path: "/20/" }, // Sweets
  { host: "dat.2chan.net", path: "/21/" }, // Ramen
  { host: "dat.2chan.net", path: "/e/" }, // Vehicles
  { host: "dat.2chan.net", path: "/j/" }, // Two-Wheelers
  { host: "nov.2chan.net", path: "/37/" }, // Bicycles
  { host: "dat.2chan.net", path: "/45/" }, // Cameras
  { host: "dat.2chan.net", path: "/48/" }, // Consumer Electronics
  { host: "dat.2chan.net", path: "/r/" }, // Trains
  { host: "dat.2chan.net", path: "/img2/" }, // 2D
  { host: "dec.2chan.net", path: "/58/" }, // 2D Alt Non-republishable
  { host: "dec.2chan.net", path: "/59/" }, // 2D Alt Republishable
  { host: "may.2chan.net", path: "/id/" }, // 2D with IDs
  { host: "dat.2chan.net", path: "/23/" }, // Speed Grapher
  { host: "dat.2chan.net", path: "/16/" }, // 2D Material/News
  { host: "dat.2chan.net", path: "/43/" }, // 2D Industry
  { host: "dec.2chan.net", path: "/74/" }, // Fate/Grand Order
  { host: "dec.2chan.net", path: "/75/" }, // Idolm@ster
  { host: "dec.2chan.net", path: "/86/" }, // ZOIDS
  { host: "dec.2chan.net", path: "/78/" }, // Umehara General (FGC)
  { host: "jun.2chan.net", path: "/31/" }, // Video Games
  { host: "nov.2chan.net", path: "/28/" }, // Online Games (Netoge)
  { host: "dec.2chan.net", path: "/56/" }, // Social Games (Soshage)
  { host: "dec.2chan.net", path: "/60/" }, // KanColle
  { host: "dec.2chan.net", path: "/69/" }, // Moai
  { host: "dec.2chan.net", path: "/65/" }, // Touken Ranbu
  { host: "dec.2chan.net", path: "/64/" }, // Divination
  { host: "dec.2chan.net", path: "/66/" }, // Fashion
  { host: "dec.2chan.net", path: "/67/" }, // Traveling
  { host: "dec.2chan.net", path: "/68/" }, // Parenting
  { host: "may.2chan.net", path: "/webm/" }, // WebM
  { host: "dec.2chan.net", path: "/71/" }, // Yeah (Soudane)
  { host: "dec.2chan.net", path: "/82/" }, // Nintendo
  { host: "dec.2chan.net", path: "/61/" }, // Sony
  { host: "dat.2chan.net", path: "/10/" }, // Net Characters
  { host: "nov.2chan.net", path: "/34/" }, // Roleplaying
  { host: "zip.2chan.net", path: "/11/" }, // OC Artwork
  { host: "zip.2chan.net", path: "/14/" }, // OC Artwork Alt
  { host: "zip.2chan.net", path: "/32/" }, // Crossdressing
  { host: "zip.2chan.net", path: "/15/" }, // Bara
  { host: "zip.2chan.net", path: "/7/" }, // Yuri
  { host: "zip.2chan.net", path: "/8/" }, // Yaoi
  { host: "zip.2chan.net", path: "/3/" }, // Self-Made PCs
  { host: "cgi.2chan.net", path: "/g/" }, // Tokusatsu
  { host: "zip.2chan.net", path: "/2/" }, // Mecha/Robot
  { host: "dec.2chan.net", path: "/63/" }, // Movies
  { host: "dat.2chan.net", path: "/44/" }, // Toys
  { host: "dat.2chan.net", path: "/v/" }, // Model Kits
  { host: "nov.2chan.net", path: "/y/" }, // Model Kits Alt (nov)
  { host: "jun.2chan.net", path: "/47/" }, // Model Kits Alt (jun)
  { host: "dec.2chan.net", path: "/73/" }, // VTubers
  { host: "dec.2chan.net", path: "/81/" }, // Vocaloid
  { host: "dat.2chan.net", path: "/x/" }, // 3DCG
  { host: "dec.2chan.net", path: "/85/" }, // Artificial Intelligence
  { host: "nov.2chan.net", path: "/35/" }, // Politics
  { host: "nov.2chan.net", path: "/36/" }, // Economy
  { host: "dec.2chan.net", path: "/79/" }, // Religion
  { host: "dec.2chan.net", path: "/50/" }, // 3D Live Commentary
  { host: "cgi.2chan.net", path: "/f/" }, // Military
  { host: "may.2chan.net", path: "/39/" }, // Military Alt
  { host: "cgi.2chan.net", path: "/m/" }, // Mathematics
  { host: "cgi.2chan.net", path: "/i/" }, // Flash
  { host: "cgi.2chan.net", path: "/k/" }, // Wallpapers
  { host: "dat.2chan.net", path: "/l/" }, // 2D/Wallpapers
  { host: "may.2chan.net", path: "/40/" }, // Touhou
  { host: "zip.2chan.net", path: "/p/" }, // Oekaki
  { host: "nov.2chan.net", path: "/q/" }, // Doodles
  { host: "cgi.2chan.net", path: "/u/" }, // Doodles Alt
  { host: "jun.2chan.net", path: "/oe/" }, // Oekaki MySQL
  { host: "jun.2chan.net", path: "/72/" }, // Oekaki MySQL with IPs
  { host: "zip.2chan.net", path: "/6/" }, // News Main
  { host: "dec.2chan.net", path: "/76/" }, // Showa Era
  { host: "dec.2chan.net", path: "/77/" }, // Heisei Era
  { host: "dec.2chan.net", path: "/53/" }, // Power Generation
  { host: "dec.2chan.net", path: "/52/" }, // Natural Disasters
  { host: "dec.2chan.net", path: "/83/" }, // Corona
  { host: "img.2chan.net", path: "/9/" }, // Idle Chat
  { host: "dec.2chan.net", path: "/70/" }, // Board Proposals
  { host: "ipv6.2chan.net", path: "/54/" }, // IPv6
  { host: "may.2chan.net", path: "/layout/" }, // Layout
  { host: "jun.2chan.net", path: "/junbi/" }, // Preparation (report)
  { host: "cgi.2chan.net", path: "/o/" },
  { host: "zip.2chan.net", path: "/5/" },
  { host: "dat.2chan.net", path: "/b/" },
  { host: "jun.2chan.net", path: "/51/" },
  { host: "dec.2chan.net", path: "/55/" },
  { host: "May.2chan.net", path: "/39/" },
  { host: "jun.2chan.net", path: "/30/" }, // (unlabeled in source board list)
  { host: "dec.2chan.net", path: "/41/" }, // (unlabeled in source board list)
];

export function getBoards(): Board[] {
  return [...NATIVE_CRON_BOARDS, ...GET_CRON_BOARDS].filter((b) => b.host && b.path);
}

export function boardSlug(board: Board): string {
  return `${board.host}${board.path}`.replace(/[^a-z0-9]+/gi, "_");
}

export function archivedKeyFor(board: Board, threadId: string): string {
  return `_state/archived/${boardSlug(board)}/${threadId}.json`;
}

export function pendingKeyFor(board: Board, threadId: string): string {
  return `_state/pending/${boardSlug(board)}/${threadId}.json`;
}
