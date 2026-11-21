import unittest

from experiments.vision.coordinates import clamp_box, roi_xyxy, unletterbox


class CoordinatesTest(unittest.TestCase):
    def test_non_square_reference_roi_uses_source_pixels(self):
        self.assertEqual(roi_xyxy((20, 30, 100, 50), (320, 180)), (20, 30, 120, 80))

    def test_edge_boxes_clamp_to_original_frame(self):
        self.assertEqual(clamp_box((-5, 0, 350, 190), (320, 180)), (0, 0, 320, 180))

    def test_empty_reversed_and_nonfinite_boxes_are_rejected(self):
        for box in [
            (1, 1, 1, 3),
            (4, 0, 2, 5),
            (330, 0, 350, 20),
            (0, float("nan"), 2, 3),
            (0, 0, float("inf"), 3),
        ]:
            with self.subTest(box=box), self.assertRaises(ValueError):
                clamp_box(box, (320, 180))

    def test_roi_rejects_negative_extent(self):
        with self.assertRaises(ValueError):
            roi_xyxy((0, 0, -2, 3), (320, 180))

    def test_letterbox_maps_once_to_wide_original(self):
        # 1280x720 -> 640x360 plus 140 vertical pixels each side.
        self.assertEqual(
            unletterbox((50, 165, 250, 315), (1280, 720), (0.5, 0.5), (0, 140)), (100, 50, 500, 350)
        )

    def test_stretched_resize_has_separate_scales(self):
        self.assertEqual(unletterbox((10, 20, 50, 60), (400, 200), (0.5, 1), (0, 0)), (20, 20, 100, 60))

    def test_invalid_transform_is_rejected(self):
        for gain in [(0, 1), (1, float("nan")), (-1, 1)]:
            with self.subTest(gain=gain), self.assertRaises(ValueError):
                unletterbox((0, 0, 5, 5), (320, 180), gain, (0, 0))


if __name__ == "__main__":
    unittest.main()
