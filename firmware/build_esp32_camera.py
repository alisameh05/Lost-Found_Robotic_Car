"""Compile the selected camera without printing credentials or uploading firmware."""

import argparse
import json
import os
import re
import shutil
import subprocess
from hashlib import sha256
from pathlib import Path
from secrets import token_hex

SOURCE = Path(__file__).resolve().parent / "esp32_camera" / "esp32_camera.ino"
TARGET = "esp32:esp32:esp32cam"
VARIANT = "ai-thinker-rhyx-gc2145"
CLI = "1.6.0"
CORE = "3.3.13"
PINS = "71de6987ee84a6d119596f3b52c8aead1b4a8e48cf4a7c3e1f39cc050ecf2754"


def private_config(path: Path) -> tuple[str, str, str, int]:
    with path.open("rb") as stream:
        config = json.loads(stream.read(4097))
    if not isinstance(config, dict) or config.keys() != {"ssid", "password", "token", "port"}:
        raise ValueError("Provide the approved local Wi-Fi and camera settings")
    ssid, password, token, port = (config[key] for key in ("ssid", "password", "token", "port"))
    if (not isinstance(ssid, str) or not 1 <= len(ssid.encode("utf-8")) <= 32 or "\x00" in ssid
            or not isinstance(password, str) or not re.fullmatch(r"[ -~]{8,63}", password)
            or not isinstance(token, str) or not re.fullmatch(r"[a-f0-9]{64}", token)
            or type(port) is not int or not 1 <= port <= 65535):
        raise ValueError("The local camera configuration is invalid")
    return ssid, password, token, port


def c_string(name: str, value: str) -> str:
    return f'constexpr char {name}[] = "' + "".join(f"\\x{byte:02x}" for byte in value.encode("utf-8")) + '";'


def build(args: argparse.Namespace) -> None:
    repo = SOURCE.parents[2]
    out = args.output.resolve()
    config = args.config.resolve() if args.config else None
    if not args.compile_only and (out.is_relative_to(repo) or config is None or config.is_relative_to(repo)):
        raise ValueError("Keep selected camera configuration and binaries in a protected directory outside Git")
    ssid, password, token, port = ("laf-compile-only", "fixture-only", "0" * 64, 8081) if args.compile_only else private_config(config)
    cli = shutil.which("arduino-cli")
    if cli is None or f"Version: {CLI} " not in subprocess.check_output([cli, "version"], text=True):
        raise ValueError("The pinned Arduino CLI is required")
    data = args.arduino_data.resolve()
    environment = {**os.environ, "ARDUINO_DIRECTORIES_DATA": str(data)}
    installed = json.loads(subprocess.check_output([cli, "core", "list", "--json"], env=environment))
    if not any(platform["id"] == "esp32:esp32" and platform["installed_version"] == CORE
               for platform in installed["platforms"]):
        raise ValueError("The active ESP32 core does not match the pinned version")
    esp32 = data / "packages" / "esp32"
    pins = esp32 / "hardware" / "esp32" / CORE / "libraries" / "ESP32" / "examples" / "Camera" / "CameraWebServer" / "camera_pins.h"
    pin_bytes = pins.read_bytes()
    if sha256(pin_bytes).hexdigest() != PINS:
        raise ValueError("The pinned CameraWebServer pin definitions did not match")
    for tool, version in (("esp-x32", "2610"), ("esp32-libs", CORE), ("esptool_py", "5.3.1")):
        if not (esp32 / "tools" / tool / version).is_dir():
            raise ValueError("A pinned ESP32 toolchain component is unavailable")
    out.mkdir(parents=True, exist_ok=False)
    sketch = out / "esp32_camera"
    sketch.mkdir()
    shutil.copyfile(SOURCE, sketch / SOURCE.name)
    (sketch / "camera_pins.h").write_bytes(pin_bytes)
    build_id = token_hex(16)
    header = sketch / "local_build.h"
    header.write_text("\n".join((c_string("CameraSsid", ssid), c_string("CameraWifiPassword", password),
                                c_string("CameraAuthorization", f"Bearer {token}"),
                                c_string("CameraBuildId", build_id), f"constexpr uint16_t CameraPort = {port};\n")),
                      encoding="ascii")
    output = out / "build"
    try:
        with (out / "compile.log").open("wb") as log:
            subprocess.run([cli, "compile", "--fqbn", TARGET, "--build-path", str(output), str(sketch)],
                           stdout=log, stderr=subprocess.STDOUT, env=environment, check=True)
    finally:
        header.unlink()
    image = output / "esp32_camera.ino.bin"
    name = "compile-only.json" if args.compile_only else "camera-build.json"
    artifact = {
        "version": 1, "variant": VARIANT, "build_id": build_id, "target": TARGET,
        "firmware_sha256": sha256(image.read_bytes()).hexdigest(),
        "tools": {"arduino-cli": CLI, "esp-x32-gcc": "14.4.0", "esptool_py": "5.3.1"},
        "cores": {"esp32": CORE}, "libraries": {"esp32-libs": CORE, "WiFi": CORE},
    }
    if args.compile_only:
        artifact["kind"] = "CompileOnly"
    (out / name).write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    print(f"Built {VARIANT} ({'compile-only' if args.compile_only else 'selected device'}). Image SHA-256 {artifact['firmware_sha256']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    choice = parser.add_mutually_exclusive_group(required=True)
    choice.add_argument("--compile-only", action="store_true")
    choice.add_argument("--config", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--arduino-data", type=Path, required=True)
    args = parser.parse_args()
    try:
        build(args)
    except (OSError, ValueError, subprocess.CalledProcessError):
        parser.exit(1, "Camera build failed. Check the local configuration, pinned toolchain and protected compile.log.\n")


if __name__ == "__main__":
    main()
