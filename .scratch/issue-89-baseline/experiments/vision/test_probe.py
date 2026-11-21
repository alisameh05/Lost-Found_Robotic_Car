import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from experiments.vision.probe import normalized_image


class ProbeTest(unittest.TestCase):
    def test_orientation_is_normalized_before_source_roi_is_used(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "portrait.jpg"
            image = Image.new("RGB", (120, 60), "red")
            image.paste((0, 255, 0), (10, 5, 30, 25))
            exif = image.getexif()
            exif[274] = 6  # 90 degrees clockwise; source selection uses 60x120.
            image.save(path, exif=exif)
            normalized = normalized_image(path)
            self.assertEqual(normalized.shape, (120, 60, 3))
            self.assertGreater(int(normalized[10, 10, 2]), 240)  # OpenCV BGR.
            self.assertGreater(int(normalized[20, 45, 1]), 240)  # Rotated green patch.

    def test_offline_guard_prevents_real_outbound_connection(self):
        code = (
            "from experiments.vision.probe import deny_network; import socket; "
            'deny_network([]); socket.create_connection(("example.com", 443))'
        )
        result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Offline probe denied socket.getaddrinfo", result.stderr)

    def test_missing_local_asset_produces_failed_evidence_without_fetching(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "experiments.vision.probe",
                    "--assets",
                    directory,
                    "--output",
                    str(output),
                    "--condition",
                    "Missing-asset check",
                ],
                capture_output=True,
                text=True,
            )
            report = json.loads(output.read_text())
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(report["failures"])
            self.assertEqual(report["network_attempts"], [])
            self.assertEqual(report["models"], [])


if __name__ == "__main__":
    unittest.main()
