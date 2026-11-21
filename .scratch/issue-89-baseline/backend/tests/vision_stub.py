"""Controllable spawned process for loopback matching tests."""

import json
import os
from io import BytesIO
from pathlib import Path
from time import sleep

from PIL import Image

from backend.app.vision_worker import FrameLimits, LocalPipe, WorkerFault, receive, send


def publish(path: Path, data: str) -> None:
    staging = path.with_suffix(".tmp")
    staging.write_text(data, encoding="utf-8")
    staging.replace(path)


def controlled_worker(pipe: LocalPipe, boot: str, worker: str, assets: Path | None, settings: Path,
                      limits: FrameLimits) -> None:
    settings.mkdir(exist_ok=True)
    with pipe:
        send(pipe, {"kind": "ready", "boot": boot, "worker": worker})
        while True:
            try:
                header = receive(pipe)
            except WorkerFault:
                return
            response = {**header, "box": None}
            image = pipe.recv_bytes(int(header["size"])) if "size" in header else b""
            if header["kind"] == "prepare":
                with Image.open(BytesIO(image)) as reference:
                    assert reference.size == (header["width"], header["height"])
                publish(settings / "prompt.json", json.dumps(header))
            if header["kind"] == "probe" and (settings / "record-probe").exists():
                (settings / "record-probe").unlink()
                publish(settings / "probe.json", json.dumps(header))
            if header["kind"] == "frame" and (settings / "record-next").exists():
                (settings / "record-next").unlink()
                publish(settings / "next-frame.json", json.dumps(header))
            if header["kind"] == "frame" and (settings / "candidate.json").exists():
                response["box"] = json.loads((settings / "candidate.json").read_text(encoding="utf-8"))
                publish(settings / "matched.json", json.dumps(header))
            if header["kind"] == "frame" and (settings / "request").exists():
                directive = (settings / "request").read_text(encoding="utf-8")
                (settings / "request").unlink()
                (settings / "analyzed.jpg").write_bytes(image)
                publish(settings / "frame.json", json.dumps(header))
                if directive == "exit":
                    os._exit(7)
                if directive == "bad-scope":
                    response["generation"] = -1
                elif directive == "bad-box":
                    width = int(header["width"])
                    response["box"] = [width + 1, 1, width + 2, 2]
                else:
                    while not (settings / "release").exists():
                        sleep(0.01)
                    if directive == "candidate":
                        response["box"] = [2.25, 3.5, 6.25, 9.5]
            send(pipe, response)
