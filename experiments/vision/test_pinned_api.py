"""Checks against the installed API; run separately from dependency-light tests."""

import importlib.util
import os
import unittest
from pathlib import Path


@unittest.skipUnless(importlib.util.find_spec("ultralytics"), "Pinned runtime is not installed")
class PinnedApiTest(unittest.TestCase):
    def test_wide_target_box_is_mapped_to_original_pixels(self):
        os.environ["YOLO_CONFIG_DIR"] = str(Path(".local-runtime/test-ultralytics-config").resolve())
        os.environ["YOLO_AUTOINSTALL"] = "false"
        os.environ["YOLO_OFFLINE"] = "true"
        import torch
        from ultralytics.utils.ops import scale_boxes

        # Square model input has 140-pixel top/bottom padding for 1280x720.
        boxes = torch.tensor([[50.0, 165.0, 250.0, 315.0]])
        original = scale_boxes((640, 640), boxes, (720, 1280))
        self.assertEqual(original.tolist(), [[100, 50, 500, 350]])


if __name__ == "__main__":
    unittest.main()
