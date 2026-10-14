import importlib.util
import unittest
from copy import deepcopy
from pathlib import Path


SPEC = importlib.util.spec_from_file_location(
    "three_anchor_ba", Path(__file__).with_name("three-anchor-ba.py")
)
assert SPEC is not None and SPEC.loader is not None
driver = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(driver)


class HardLockReportTest(unittest.TestCase):
    anchors = ("first.jpg", "middle.jpg", "last.jpg")

    def setUp(self):
        self.poses = {
            name: {
                "quaternionXyzw": [0.0, 0.0, 0.0, 1.0],
                "translation": [float(index), 0.0, 0.0],
                "centre": [-float(index), 0.0, 0.0],
            }
            for index, name in enumerate(self.anchors)
        }
        self.intrinsics = {"1": {"params": [500.0, 500.0, 320.0, 240.0]}}
        self.identity = {"images": [1, 2, 3], "points": [7]}

    def report(self, after_poses, after_identity=None):
        return driver.hard_lock_report(
            self.poses,
            after_poses,
            self.intrinsics,
            self.intrinsics,
            self.identity,
            self.identity if after_identity is None else after_identity,
            self.anchors,
        )

    def test_accepts_sign_equivalent_unchanged_locks(self):
        after = deepcopy(self.poses)
        after["middle.jpg"]["quaternionXyzw"] = [0.0, 0.0, 0.0, -1.0]

        self.assertTrue(self.report(after)["passed"])

    def test_rejects_rotation_anchor_scale_and_identity_changes(self):
        rotation = deepcopy(self.poses)
        rotation["middle.jpg"]["quaternionXyzw"] = [0.0, 0.0, 1.0, 0.0]
        self.assertFalse(self.report(rotation)["passed"])

        anchor = deepcopy(self.poses)
        anchor["last.jpg"]["translation"][0] += 0.01
        anchor["last.jpg"]["centre"][0] -= 0.01
        self.assertFalse(self.report(anchor)["passed"])

        self.assertFalse(self.report(self.poses, {"images": [], "points": []})["passed"])


if __name__ == "__main__":
    unittest.main()
