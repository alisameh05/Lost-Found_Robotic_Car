"""Provision or verify the hash-pinned local vision assets."""

import argparse
import hashlib
import json
import urllib.request
from pathlib import Path


def verify(path: Path, expected: str) -> bool:
    if not path.is_file():
        return False
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest() == expected


def prepare(destination: Path, *, offline: bool = False) -> None:
    manifest = json.loads(Path(__file__).with_name("assets.json").read_text())
    if not offline:
        destination.mkdir(parents=True, exist_ok=True)
    for name, entry in manifest.items():
        path = destination / name
        if verify(path, entry["sha256"]):
            print(f"{name}: already verified")
            continue
        if offline:
            raise ValueError(f"Missing or incompatible offline asset: {name}")
        # A mismatched response is never installed at the trusted model path.
        with urllib.request.urlopen(entry["url"], timeout=180) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise ValueError(f"Upstream bytes changed: {name}; inspect before updating the manifest")
        path.write_bytes(data)
        print(f"{name}: downloaded and verified")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--verify", action="store_true", help="Verify installed assets without downloading.")
    args = parser.parse_args()
    prepare(args.destination, offline=args.verify)
