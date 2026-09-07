#!/usr/bin/env python3
"""
Download every zip file linked from one or more tsumanne.net listing pages,
e.g. https://tsumanne.net/si/all/1

Usage:
    # single page
    python download_zips.py "https://tsumanne.net/si/all/1" --out downloads

    # a range of pages: https://tsumanne.net/si/all, /all/1, /all/2 ... /all/9
    python download_zips.py --base "https://tsumanne.net/si/all" --pages 0 9 --out downloads
"""

import argparse
import re
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; zip-downloader/1.0)"}


def page_url_for(base: str, page: int) -> str:
    """page 0 -> base itself, page N -> base/N (matches tsumanne.net's pagination)."""
    return base if page == 0 else f"{base.rstrip('/')}/{page}"


def infer_link_base(page_url: str) -> str:
    """
    tsumanne.net pages declare a <base> tag (base: /si/) that all relative
    links resolve against — NOT the page's own URL. A page at
    https://tsumanne.net/si/all/7120 still has its zip links resolve
    against https://tsumanne.net/si/. This finds that base by cutting the
    path right before "/all".
    """
    parsed = urlparse(page_url)
    path = parsed.path
    idx = path.find("/all")
    if idx != -1:
        base_path = path[:idx] + "/"
    else:
        # Fallback: treat the parent directory of the given path as the base.
        base_path = path.rsplit("/", 1)[0] + "/"
    return f"{parsed.scheme}://{parsed.netloc}{base_path}"


def find_zip_links(page_url: str) -> tuple[list[str], list[str]]:
    """Fetch a listing page and return (absolute zip URLs, thread IDs)."""
    resp = requests.get(page_url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    html = resp.text

    ids = re.findall(r'zip\.php\?id=(\d+)', html)
    ids = sorted(set(ids), key=int, reverse=True)  # dedupe, newest first

    link_base = infer_link_base(page_url)
    links = [urljoin(link_base, f"zip.php?id={i}") for i in ids]
    return links, ids


def download(url: str, dest: Path, delay: float) -> None:
    resp = requests.get(url, headers=HEADERS, timeout=60)
    resp.raise_for_status()
    dest.write_bytes(resp.content)
    time.sleep(delay)  # be polite, avoid hammering the server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("page_url", nargs="?", help="A single listing page URL")
    parser.add_argument("--base", help="Base listing URL to paginate over, e.g. https://tsumanne.net/si/all")
    parser.add_argument("--pages", nargs=2, type=int, metavar=("START", "END"),
                         help="Page range (inclusive) to fetch when using --base, e.g. 0 9")
    parser.add_argument("--out", default="downloads", help="Output directory")
    parser.add_argument("--delay", type=float, default=0.5, help="Seconds to wait between downloads")
    args = parser.parse_args()

    if not args.page_url and not args.base:
        parser.error("Provide either a single page_url or --base with --pages")

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    page_urls = []
    if args.page_url:
        page_urls.append(args.page_url)
    if args.base:
        start, end = args.pages or (0, 0)
        page_urls.extend(page_url_for(args.base, p) for p in range(start, end + 1))

    seen_ids = set()
    total_new = 0
    failures = 0

    for page_url in page_urls:
        print(f"Scanning {page_url}")
        try:
            links, ids = find_zip_links(page_url)
        except requests.RequestException as e:
            print(f"  [fail] could not fetch page: {e}")
            failures += 1
            continue

        print(f"  found {len(links)} zip link(s)")
        for zip_url, thread_id in zip(links, ids):
            if thread_id in seen_ids:
                continue
            seen_ids.add(thread_id)

            dest = out_dir / f"{thread_id}.zip"
            if dest.exists():
                print(f"  [skip] {dest.name} already exists")
                continue
            try:
                print(f"  [get]  {zip_url} -> {dest}")
                download(zip_url, dest, delay=args.delay)
                total_new += 1
            except requests.RequestException as e:
                print(f"  [fail] {zip_url}: {e}")
                failures += 1

    print(f"Done. Downloaded {total_new} new zip file(s) into {out_dir}/")

    if failures:
        print(f"{failures} failure(s) occurred — exiting non-zero so callers know this run was incomplete.")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
