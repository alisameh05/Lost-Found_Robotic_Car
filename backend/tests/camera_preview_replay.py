"""Run the protected Device preview against a camera wire peer for Playwright."""

import asyncio
from io import BytesIO
from time import perf_counter

import uvicorn
from PIL import Image

from backend.app.camera_link import CLOCK, CameraFault, Reply
from backend.app.config import LOOPBACK, Config
from backend.app.main import create_app
from backend.app.simulation import FIXTURES
from backend.tests.device_documents import write_camera_documents


def main() -> None:
    config = Config.from_environment()
    build, boot, stream = "a" * 32, "b" * 32, "c" * 32
    write_camera_documents(config.data_root, build, "1" * 64)
    dropped = config.data_root / "replay-drop-camera"
    with Image.open(FIXTURES / "robot.jpg") as image, BytesIO() as buffer:
        image.resize((320, 240)).save(buffer, format="JPEG")
        jpeg = buffer.getvalue()
    sequence = 0

    async def peer(path, headers, read_body, timeout):
        nonlocal sequence
        if dropped.exists():
            raise CameraFault("Camera connection dropped in the browser fixture")
        if path == CLOCK:
            stamp = int(perf_counter() * 1_000_000)
            meta = f"1 {headers['X-LAF-Request']} {headers['X-LAF-Epoch']} {build} {boot} {stream} {stamp} {stamp}"
            fields = {"x-laf-clock": meta, "content-length": "0"}
        else:
            await asyncio.sleep(0.03)
            sequence += 1
            stamp = int(perf_counter() * 1_000_000)
            meta = f"1 {build} {boot} {stream} {sequence} {stamp} 320 240"
            fields = {"x-laf-frame": meta, "content-length": str(len(jpeg)), "content-type": "image/jpeg"}
        size = read_body(200, fields, 256)
        return Reply(jpeg if size else b"", perf_counter())

    app = create_app(config, camera_exchange=peer)
    uvicorn.run(app, host=LOOPBACK, port=config.backend_port, proxy_headers=False, access_log=False,
                ws_max_size=app.state.socket_message_limit, ws_max_queue=1, ws_per_message_deflate=False)


if __name__ == "__main__":
    main()
