"""Inventory installed wheel metadata and retain their license/NOTICE files."""

import hashlib
import importlib.metadata
import json
from pathlib import Path


def export(destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    packages = []
    for distribution in importlib.metadata.distributions():
        metadata = distribution.metadata
        name = metadata["Name"]
        notices = []
        for file in distribution.files or []:
            if ".dist-info" not in str(file) or not any(
                term in file.name.lower() for term in ("license", "notice", "copying")
            ):
                continue
            data = Path(str(distribution.locate_file(file))).read_bytes()
            target = destination / name / str(file).replace("/", "__").replace("\\", "__")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            notices.append(
                {
                    "file": target.relative_to(destination).as_posix(),
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
            )
        license_text = metadata["License-Expression"] or metadata["License"] or ""
        packages.append(
            {
                "name": name,
                "version": distribution.version,
                "license_metadata": license_text
                if len(license_text) < 300
                else "Full text retained in installed license files",
                "license_classifiers": [
                    value for value in metadata.get_all("Classifier", []) if value.startswith("License")
                ],
                "project_urls": metadata.get_all("Project-URL", []),
                "requires_dist": distribution.requires,
                "notices": notices,
            }
        )
    (destination / "packages.json").write_text(
        json.dumps(sorted(packages, key=lambda p: p["name"]), indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    export(Path(".local-runtime/package-notices"))
