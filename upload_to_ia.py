#!/usr/bin/env python3
"""
Upload every file in a local folder to an Internet Archive item.

Requires:
    pip install internetarchive

Auth (get keys at https://archive.org/account/s3.php):
    Set environment variables IA_ACCESS_KEY and IA_SECRET_KEY.

Usage:
    python upload_to_ia.py \
        --dir downloads \
        --identifier tsumanne-si-page-7130 \
        --title "tsumanne.net si thread zips - page 7130" \
        --collection test_collection
"""

import argparse
import os
import sys
from pathlib import Path

from internetarchive import upload


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", required=True, help="Local folder whose files should be uploaded")
    parser.add_argument("--identifier", required=True, help="Unique, url-safe Internet Archive item identifier")
    parser.add_argument("--title", required=True, help="Item title metadata")
    parser.add_argument(
        "--collection",
        default="opensource_media",
        help="IA collection to file under (default: opensource_media).",
    )
    parser.add_argument("--mediatype", default="data", help="IA mediatype (default: data)")
    parser.add_argument("--source", help="Optional source URL to record in item metadata")
    args = parser.parse_args()

    access_key = os.environ.get("IA_ACCESS_KEY")
    secret_key = os.environ.get("IA_SECRET_KEY")
    if not access_key or not secret_key:
        sys.exit("IA_ACCESS_KEY / IA_SECRET_KEY environment variables are required.")

    src_dir = Path(args.dir)
    files = sorted(p for p in src_dir.iterdir() if p.is_file())
    if not files:
        print(f"No files found in {src_dir}, nothing to upload.")
        return

    metadata = {
        "title": args.title,
        "mediatype": args.mediatype,
        "collection": args.collection,
    }
    if args.source:
        metadata["source"] = args.source

    print(f"Uploading {len(files)} file(s) to IA item '{args.identifier}'...")
    responses = upload(
        args.identifier,
        files=[str(f) for f in files],
        metadata=metadata,
        access_key=access_key,
        secret_key=secret_key,
        verbose=True,
    )

    failed = [r for r in responses if r is not None and getattr(r, "status_code", 200) != 200]
    if failed:
        sys.exit(f"{len(failed)} file(s) failed to upload to Internet Archive.")

    print(f"Uploaded successfully: https://archive.org/details/{args.identifier}")


if __name__ == "__main__":
    main()
