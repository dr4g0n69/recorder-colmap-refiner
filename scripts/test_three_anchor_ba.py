import importlib.util
import json
import sys
import unittest
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch


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


class NativeStartTest(unittest.TestCase):
    def test_permanently_consumes_the_attempt_before_solving(self):
        with TemporaryDirectory() as directory:
            marker = Path(directory) / "ba-native-start.json"
            digest = driver.reserve_native_start(marker, "a" * 64, "b" * 64)

            self.assertEqual(digest, driver.sha256_file(marker))
            with self.assertRaises(FileExistsError):
                driver.reserve_native_start(marker, "a" * 64, "b" * 64)

    def test_only_one_concurrent_start_can_reserve_the_attempt(self):
        with TemporaryDirectory() as directory:
            marker = Path(directory) / "ba-native-start.json"

            def reserve():
                try:
                    driver.reserve_native_start(marker, "a" * 64, "b" * 64)
                    return "started"
                except FileExistsError:
                    return "blocked"

            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda _: reserve(), range(2)))

            self.assertCountEqual(results, ["started", "blocked"])


class FrozenInputTest(unittest.TestCase):
    def test_detects_a_changed_optimization_input(self):
        with TemporaryDirectory() as directory:
            run = Path(directory)
            database = run / "database" / "selected.db"
            model = run / "exports" / "triangulated"
            binary_model = run / "models" / "triangulated"
            correspondences = run / "metrics" / "correspondences.json"
            database.parent.mkdir(parents=True)
            model.mkdir(parents=True)
            binary_model.mkdir(parents=True)
            correspondences.parent.mkdir(parents=True)
            database.write_bytes(b"database")
            for filename in ("cameras.txt", "images.txt", "points3D.txt"):
                (model / filename).write_text(filename, encoding="utf-8")
            for filename in (
                "cameras.bin",
                "frames.bin",
                "images.bin",
                "points3D.bin",
                "rigs.bin",
            ):
                (binary_model / filename).write_bytes(filename.encode())
            correspondences.write_text("{}", encoding="utf-8")
            pre_ba = {
                "bindings": {
                    "matchingDatabase": {
                        "path": "database/selected.db",
                        "sha256": driver.sha256_file(database),
                    },
                    "triangulatedModel": {
                        filename: driver.sha256_file(model / filename)
                        for filename in ("cameras.txt", "images.txt", "points3D.txt")
                    },
                    "triangulatedBinaryModel": {
                        filename: driver.sha256_file(binary_model / filename)
                        for filename in (
                            "cameras.bin",
                            "frames.bin",
                            "images.bin",
                            "points3D.bin",
                            "rigs.bin",
                        )
                    },
                    "correspondencesSha256": driver.sha256_file(correspondences),
                }
            }

            driver.verify_pre_ba_bindings(run, pre_ba)
            correspondences.write_text('{"changed":true}', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Frozen correspondences changed"):
                driver.verify_pre_ba_bindings(run, pre_ba)


class DriverBoundaryTest(unittest.TestCase):
    def make_run(self, directory: str):
        run = Path(directory)
        (run / "input").mkdir()
        (run / "metrics").mkdir()
        (run / "evidence").mkdir()
        input_path = run / "input" / "original.zip"
        pre_ba_path = run / "metrics" / "pre-ba-support.json"
        input_path.write_bytes(b"zip")
        pre_ba_path.write_text(json.dumps({"status": "pass"}), encoding="utf-8")
        return run, input_path, pre_ba_path

    def args(self, run: Path, input_path: Path, pre_ba_path: Path, mode: str):
        values = [
            mode,
            "--run-directory",
            str(run),
            "--anchors",
            "first.jpg",
            "middle.jpg",
            "last.jpg",
            "--expected-pycolmap-version",
            "4.2.0",
            "--python-sha256",
            driver.sha256_file(Path(sys.executable)),
            "--input-sha256",
            driver.sha256_file(input_path),
            "--pre-ba-sha256",
            driver.sha256_file(pre_ba_path),
            "--report",
            str(run / "evidence" / f"{mode}.json"),
        ]
        if mode == "solve":
            values.extend(
                [
                    "--inspection-sha256",
                    "a" * 64,
                    "--attempt-sha256",
                    "b" * 64,
                    "--resolved-config-sha256",
                    "c" * 64,
                ]
            )
        return values

    def test_inspect_dispatch_never_calls_solve(self):
        with TemporaryDirectory() as directory:
            run, input_path, pre_ba_path = self.make_run(directory)
            pycolmap = SimpleNamespace(__version__="4.2.0")
            with (
                patch.dict(sys.modules, {"pycolmap": pycolmap}),
                patch.object(
                    driver,
                    "verify_pre_ba_bindings",
                    return_value={"inputSha256": driver.sha256_file(input_path)},
                ),
                patch.object(
                    driver,
                    "inspect_problem",
                    return_value={"schemaVersion": 1, "solveCalled": False},
                ),
                patch.object(driver, "solve_problem") as solve,
            ):
                self.assertEqual(
                    driver.main(self.args(run, input_path, pre_ba_path, "inspect")),
                    0,
                )
                solve.assert_not_called()

    def test_stale_pre_ba_hash_blocks_solve_dispatch(self):
        with TemporaryDirectory() as directory:
            run, input_path, pre_ba_path = self.make_run(directory)
            args = self.args(run, input_path, pre_ba_path, "solve")
            args[args.index("--pre-ba-sha256") + 1] = "0" * 64
            pycolmap = SimpleNamespace(__version__="4.2.0")
            with (
                patch.dict(sys.modules, {"pycolmap": pycolmap}),
                patch.object(driver, "solve_problem") as solve,
            ):
                with self.assertRaisesRegex(ValueError, "Pre-BA evidence differs"):
                    driver.main(args)
                solve.assert_not_called()

    def test_identity_proof_gates_native_start_and_solver(self):
        for verified in (False, True):
            with self.subTest(verified=verified), TemporaryDirectory() as directory:
                run = Path(directory)
                (run / "evidence").mkdir()
                (run / "models").mkdir()
                (run / "exports").mkdir()
                inspection_path = run / "evidence" / "ba-inspection.json"
                attempt_path = run / "evidence" / "ba-attempt.json"
                config_path = run / "resolved-config.json"
                pre_ba_sha256 = "d" * 64
                binary_hashes = {"native": "e" * 64}
                identity_proof = (
                    {
                        "status": "verified",
                        "method": "native-residual-identity-inventory-v1",
                        "pycolmapBinaryHashes": binary_hashes,
                    }
                    if verified
                    else {"status": "unavailable", "reason": "counts only"}
                )
                inspection = {
                    "pycolmapVersion": "4.2.0",
                    "pycolmapBinaryHashes": binary_hashes,
                    "registeredImageCount": 3,
                    "fixedFullPoseFrameCount": 3,
                    "fixedRotationFrameCount": 3,
                    "variableTranslationFrameCount": 0,
                    "fixedIntrinsicsCameraCount": 1,
                    "linkedObservationCount": 1,
                    "scalarReprojectionResidualCount": 2,
                    "anchors": [],
                    "effectiveConfig": "config",
                    "effectiveOptions": "options",
                    "residualSelection": {
                        "identityProof": identity_proof,
                        "observationIdentities": [],
                    },
                    "optimizationInputs": {},
                }
                inspection_path.write_text(json.dumps(inspection), encoding="utf-8")
                config_path.write_text("{}", encoding="utf-8")
                attempt = {
                    "schemaVersion": 1,
                    "permanent": True,
                    "inputSha256": "f" * 64,
                    "preBaSha256": pre_ba_sha256,
                    "inspectionSha256": driver.sha256_file(inspection_path),
                    "driverSha256": driver.sha256_file(Path(driver.__file__)),
                    "resolvedConfigSha256": driver.sha256_file(config_path),
                }
                attempt_path.write_text(json.dumps(attempt), encoding="utf-8")
                marker = run / "evidence" / "ba-native-start.json"

                class Adjuster:
                    solve_called = False

                    def solve(self):
                        self.solve_called = True
                        self_test.assertTrue(marker.exists())
                        return SimpleNamespace(
                            is_solution_usable=lambda: False,
                            num_residuals=2,
                            termination_type="failed",
                            brief_report=lambda: "failed",
                        )

                self_test = self
                adjuster = Adjuster()
                args = SimpleNamespace(
                    report=run / "evidence" / "ba-result.json",
                    inspection_sha256=driver.sha256_file(inspection_path),
                    attempt_sha256=driver.sha256_file(attempt_path),
                    resolved_config_sha256=driver.sha256_file(config_path),
                    input_sha256="f" * 64,
                    pre_ba_sha256=pre_ba_sha256,
                )
                with (
                    patch.object(
                        driver,
                        "build_problem",
                        return_value=(object(), adjuster, inspection),
                    ) as build_problem,
                    patch.object(driver, "pose_snapshot", return_value={}),
                    patch.object(driver, "intrinsics_snapshot", return_value={}),
                    patch.object(driver, "identity_snapshot", return_value={}),
                    patch.object(
                        driver,
                        "hard_lock_report",
                        return_value={"passed": True},
                    ),
                ):
                    expected_error = "unusable" if verified else "verified native"
                    with self.assertRaisesRegex((RuntimeError, ValueError), expected_error):
                        driver.solve_problem(
                            SimpleNamespace(),
                            run,
                            ("first.jpg", "middle.jpg", "last.jpg"),
                            args,
                        )
                self.assertEqual(marker.exists(), verified)
                self.assertEqual(adjuster.solve_called, verified)
                self.assertEqual(build_problem.called, verified)


if __name__ == "__main__":
    unittest.main()
