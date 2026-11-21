"""Build an identified Uno image without uploading it."""

import argparse
import json
import re
import shutil
import subprocess
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory

SOURCE = Path(__file__).resolve().parent / "uno"
TARGET = "arduino:avr:uno"
CLI = "1.6.0"
CORE = "1.8.8"
GCC = "7.3.0-atmel3.6.1-arduino7"
MOTOR_PWM = {5, 6, 9, 10}
HC05_BAUD = {9600, 19200, 38400}
AVR_WATCHDOG_MS = {15, 30, 60, 120, 250, 500}
SERIAL_FIELDS = ("serial_baud", "packet_ms", "challenge_lifetime_ms", "firmware_expiry_ms", "hardware_watchdog_ms")
COMMON = {"version", "profile_id", "kind", *SERIAL_FIELDS}
DEVICE = {"enable_pins", "enable_active_high", "direction_pins", "direction_levels", "duty",
          "reset_enable_levels", "reset_evidence_sha256"}
PIN_FIELDS = {"serial_rx_pin", "serial_tx_pin"}
SKETCH = ("uno.ino", "command.h", "command.cpp", "command_port.h", "command_port.cpp")


def int_in(value, low, high):
    return type(value) is int and low <= value <= high


def load_mapping(data):
    if not isinstance(data, dict):
        raise ValueError("The logical mapping must be an object")
    kind = data.get("kind")
    allowed = COMMON | DEVICE | PIN_FIELDS if kind == "Device" else COMMON | (PIN_FIELDS & data.keys())
    if kind not in ("Device", "DisabledFixture") or data.keys() != allowed:
        raise ValueError("Supply an explicit v1 Device or DisabledFixture logical mapping")
    if type(data["version"]) is not int or data["version"] != 1 or not re.fullmatch(
        r"[a-zA-Z0-9_-]{1,64}", data["profile_id"],
    ):
        raise ValueError("Invalid logical mapping version or ID")
    if (not int_in(data["serial_baud"], 1200, 230400)
            or not all(int_in(data[key], 1, 500) for key in COMMON if key.endswith("_ms"))
            or data["hardware_watchdog_ms"] not in AVR_WATCHDOG_MS
            or data["hardware_watchdog_ms"] > data["firmware_expiry_ms"]
            or not (270_000 + data["serial_baud"] - 1) // data["serial_baud"]
            < data["packet_ms"] < min(data["challenge_lifetime_ms"], data["firmware_expiry_ms"])):
        raise ValueError("Invalid serial framing or timer configuration")
    if kind == "Device" or PIN_FIELDS & data.keys():
        rx, tx = data.get("serial_rx_pin"), data.get("serial_tx_pin")
        if not int_in(rx, 2, 3) or not int_in(tx, 2, 3) or rx == tx or data["serial_baud"] not in HC05_BAUD:
            raise ValueError("The HC-05 requires distinct Uno D2/D3 UART pins and a supported line rate")
    if kind == "Device":
        enables, directions = data["enable_pins"], data["direction_pins"]
        if (len(enables) != 2 or not all(int_in(pin, 4, 19) and pin in MOTOR_PWM for pin in enables)
                or len(directions) != 4 or not all(int_in(pin, 4, 19) for pin in directions)
                or len(set(enables + directions)) != 6):
            raise ValueError("Use six distinct motor pins outside D0–D3 and PWM enables on D5/D6/D9/D10")
        polarities = data["enable_active_high"]
        if (len(polarities) != 2 or not all(type(value) is bool for value in polarities)
                or data["reset_enable_levels"] != [int(not value) for value in polarities]
                or not all(type(value) is int for value in data["reset_enable_levels"])
                or not re.fullmatch(r"[0-9a-f]{64}", data["reset_evidence_sha256"])):
            raise ValueError("Provide a verified disabled enable level for each pin while the Uno is in reset")
        levels, duties = data["direction_levels"], data["duty"]
        if (len(levels) != 5 or any(len(row) != 4 or not all(int_in(level, 0, 1) for level in row) for row in levels)
                or len(duties) != 5 or any(len(row) != 2 or not all(int_in(duty, 0, 255) for duty in row) for row in duties)
                or duties[0] != [0, 0] or any(row == [0, 0] for row in duties[1:])):
            raise ValueError("Supply direction levels and PWM for disabled, forward, backward, left and right")
    return data


def initializer(values):
    return "{" + ", ".join(initializer(item) if isinstance(item, list) else str(int(item)) for item in values) + "}"


def header(mapping, build_id):
    lines = [
        f'#define LAF_DEVICE_OUTPUT {int(mapping["kind"] == "Device")}',
        f'#define LAF_HC05_PINS {int("serial_rx_pin" in mapping)}',
        f'constexpr unsigned long Baud = {mapping["serial_baud"]}UL;',
        "constexpr uno::Timing Timings = " + initializer([
            mapping["packet_ms"], mapping["challenge_lifetime_ms"], mapping["firmware_expiry_ms"],
        ]) + ";",
        "constexpr uint8_t BuildId[32] = " + initializer(list(build_id)) + ";",
        f'constexpr uint8_t HardwareWatchdog = WDTO_{mapping["hardware_watchdog_ms"]}MS;',
    ]
    if "serial_rx_pin" in mapping:
        lines.extend((f'constexpr uint8_t RxPin = {mapping["serial_rx_pin"]};',
                      f'constexpr uint8_t TxPin = {mapping["serial_tx_pin"]};'))
    if mapping["kind"] == "Device":
        for name, extent, key in (
            ("EnablePins", "[2]", "enable_pins"),
            ("EnableHigh", "[2]", "enable_active_high"),
            ("DirectionPins", "[4]", "direction_pins"),
            ("Levels", "[5][4]", "direction_levels"),
            ("Duty", "[5][2]", "duty"),
        ):
            lines.append(f"constexpr uint8_t {name}{extent} = {initializer(mapping[key])};")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mapping", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    mapping_bytes = args.mapping.read_bytes()
    mapping = load_mapping(json.loads(mapping_bytes))
    versions = {
        "tools": {"arduino-cli": CLI, "avr-gcc": GCC},
        "cores": {"arduino:avr": CORE},
        "libraries": {"EEPROM": "2.0"},  # Supplied by the pinned AVR core.
    }
    cli_version = subprocess.check_output(["arduino-cli", "version", "--format", "json"], text=True)
    if json.loads(cli_version)["VersionString"] != CLI:
        raise ValueError(f"Install Arduino CLI {CLI}")
    core_list = subprocess.check_output(["arduino-cli", "core", "list", "--format", "json"], text=True)
    if not any(core["id"] == "arduino:avr" and core["installed_version"] == CORE
               for core in json.loads(core_list)["platforms"]):
        raise ValueError(f"Install arduino:avr@{CORE}")

    digest = sha256(json.dumps({"target": TARGET, **versions}, sort_keys=True).encode())
    digest.update(Path(__file__).read_bytes().replace(b"\r\n", b"\n"))
    for name in SKETCH:
        digest.update(SOURCE.joinpath(name).read_bytes().replace(b"\r\n", b"\n"))
    logical_digest = sha256(mapping_bytes).hexdigest()
    digest.update(bytes.fromhex(logical_digest))
    build_id = digest.digest()
    args.output.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="laf-uno-") as temp:
        sketch = Path(temp, "uno")
        sketch.mkdir()
        for name in SKETCH:
            shutil.copyfile(SOURCE / name, sketch / name)
        sketch.joinpath("selected_build.h").write_text(header(mapping, build_id), encoding="ascii")
        compile_command = ["arduino-cli", "compile", "--fqbn", TARGET]
        properties = dict(
            line.split("=", 1) for line in subprocess.check_output(
                [*compile_command, "--show-properties=expanded", str(sketch)], text=True,
            ).splitlines() if "=" in line
        )
        compiler = Path(properties["compiler.path"])
        platform = Path(properties["runtime.platform.path"])
        eeprom = platform / "libraries" / "EEPROM"
        if compiler.parent.name != GCC or platform.name != CORE or (
            "version=2.0" not in eeprom.joinpath("library.properties").read_text(encoding="utf-8").splitlines()
        ):
            raise ValueError("Unexpected AVR compiler, platform, or EEPROM library selected by the CLI")
        subprocess.run([*compile_command, "--library", str(eeprom), "--output-dir", str(args.output.resolve()),
                        "--warnings", "all", str(sketch)], check=True)
    firmware = sha256(args.output.joinpath("uno.ino.hex").read_bytes()).hexdigest()
    artifact = {
        "version": 1, "kind": mapping["kind"], "build_id": build_id.hex(),
        "target": TARGET, **versions, "firmware_sha256": firmware, "logical_output_sha256": logical_digest,
        **{key: mapping[key] for key in SERIAL_FIELDS},
    }
    if mapping["kind"] == "Device":
        artifact["reset_evidence_sha256"] = mapping["reset_evidence_sha256"]
    if "serial_rx_pin" in mapping:
        artifact.update({key: mapping[key] for key in sorted(PIN_FIELDS)})
    args.output.joinpath("build.json").write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    print(f"Uno firmware SHA-256 {firmware}")


if __name__ == "__main__":
    main()
