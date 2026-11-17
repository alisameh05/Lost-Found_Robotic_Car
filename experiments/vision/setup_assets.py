"""Deliberate network setup only. The probe never imports this module."""

import argparse
import hashlib
import json
import urllib.request
from pathlib import Path


def download(destination: Path) -> None:
    manifest = json.loads(Path(__file__).with_name("assets.json").read_text())
    destination.mkdir(parents=True, exist_ok=True)
    for name, entry in manifest.items():
        path = destination / name
        if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == entry["sha256"]:
            print(f"{name}: already verified")
            continue
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
    download(parser.parse_args().destination)
