"""Inspect or execute one hash-bound three-anchor PyCOLMAP adjustment."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
from pathlib import Path
from typing import Any


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return value


def json_default(value: Any) -> Any:
    if hasattr(value, "tolist"):
        return value.tolist()
    if hasattr(value, "name"):
        return value.name
    return str(value)


def write_json_once(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as output:
        json.dump(value, output, indent=2, default=json_default, allow_nan=False)
        output.write("\n")


def reserve_native_start(
    path: Path, attempt_sha256: str, inspection_sha256: str
) -> str:
    write_json_once(
        path,
        {
            "schemaVersion": 1,
            "permanent": True,
            "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "attemptSha256": attempt_sha256,
            "inspectionSha256": inspection_sha256,
        },
    )
    return sha256_file(path)


def file_hashes(directory: Path, filenames: tuple[str, ...]) -> dict[str, str]:
    return {name: sha256_file(directory / name) for name in filenames}


def verify_pre_ba_bindings(run_directory: Path, pre_ba: dict[str, Any]) -> dict[str, Any]:
    bindings = pre_ba.get("bindings")
    if not isinstance(bindings, dict):
        raise ValueError("Pre-BA evidence lacks frozen input bindings")
    database = bindings.get("matchingDatabase")
    model = bindings.get("triangulatedModel")
    binary_model = bindings.get("triangulatedBinaryModel")
    if (
        not isinstance(database, dict)
        or not isinstance(model, dict)
        or not isinstance(binary_model, dict)
    ):
        raise ValueError("Pre-BA evidence has malformed input bindings")
    database_path = (run_directory / str(database.get("path", ""))).resolve()
    try:
        database_path.relative_to(run_directory)
    except ValueError as error:
        raise ValueError("Matching database path escapes the run directory") from error
    if sha256_file(database_path) != database.get("sha256"):
        raise ValueError("Frozen matching database changed")
    for filename in ("cameras.txt", "images.txt", "points3D.txt"):
        if (
            sha256_file(run_directory / "exports" / "triangulated" / filename)
            != model.get(filename)
        ):
            raise ValueError(f"Frozen triangulated {filename} changed")
    for filename in (
        "cameras.bin",
        "frames.bin",
        "images.bin",
        "points3D.bin",
        "rigs.bin",
    ):
        if (
            sha256_file(run_directory / "models" / "triangulated" / filename)
            != binary_model.get(filename)
        ):
            raise ValueError(f"Frozen triangulated {filename} changed")
    if (
        sha256_file(run_directory / "metrics" / "correspondences.json")
        != bindings.get("correspondencesSha256")
    ):
        raise ValueError("Frozen correspondences changed")
    return bindings


def runtime_identity(pycolmap: Any) -> dict[str, Any]:
    module = Path(pycolmap.__file__).resolve()
    binaries = {
        str(path.resolve()): sha256_file(path)
        for path in sorted(module.parent.glob("_core*"))
        if path.is_file()
    }
    if not binaries:
        raise ValueError("PyCOLMAP native binary was not found")
    return {
        "pythonVersion": sys.version.split()[0],
        "pythonExecutable": str(Path(sys.executable).resolve()),
        "pycolmapVersion": pycolmap.__version__,
        "pycolmapModule": str(module),
        "pycolmapBinaryHashes": binaries,
    }


def image_by_name(reconstruction: Any) -> dict[str, Any]:
    images = {image.name: image for image in reconstruction.images.values()}
    if len(images) != len(reconstruction.images):
        raise ValueError("Duplicate image names in triangulated model")
    return images


def validate_pose(image: Any) -> None:
    pose = image.cam_from_world()
    quaternion = [float(value) for value in pose.rotation.quat]
    translation = [float(value) for value in pose.translation]
    if not all(math.isfinite(value) for value in (*quaternion, *translation)):
        raise ValueError(f"Nonfinite pose for {image.name}")
    if abs(math.hypot(*quaternion) - 1.0) > 1e-6:
        raise ValueError(f"Non-unit quaternion for {image.name}")


def pose_snapshot(reconstruction: Any) -> dict[str, dict[str, list[float]]]:
    result = {}
    for image in reconstruction.images.values():
        validate_pose(image)
        pose = image.cam_from_world()
        result[image.name] = {
            "quaternionXyzw": [float(value) for value in pose.rotation.quat],
            "translation": [float(value) for value in pose.translation],
            "centre": [float(value) for value in pose.inverse().translation],
        }
    return result


def intrinsics_snapshot(reconstruction: Any) -> dict[str, Any]:
    return {
        str(camera_id): {
            "model": str(camera.model),
            "width": camera.width,
            "height": camera.height,
            "params": [float(value) for value in camera.params],
        }
        for camera_id, camera in reconstruction.cameras.items()
    }


def identity_snapshot(reconstruction: Any) -> dict[str, Any]:
    images = {}
    for image in reconstruction.images.values():
        images[image.name] = {
            "imageId": image.image_id,
            "cameraId": image.camera_id,
            "frameId": image.frame_id,
            "observations": [
                {
                    "xy": [float(value) for value in point.xy],
                    "point3DId": point.point3D_id if point.has_point3D() else None,
                }
                for point in image.points2D
            ],
        }
    points = {
        str(point_id): [
            [element.image_id, element.point2D_idx] for element in point.track.elements
        ]
        for point_id, point in reconstruction.points3D.items()
    }
    return {"images": images, "points": points}


def vector_delta(first: list[float], second: list[float]) -> float:
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(first, second, strict=True)))


def quaternion_delta(first: list[float], second: list[float]) -> float:
    direct = max(abs(a - b) for a, b in zip(first, second, strict=True))
    negated = max(abs(a + b) for a, b in zip(first, second, strict=True))
    return min(direct, negated)


def anchor_distances(
    poses: dict[str, dict[str, list[float]]], anchors: tuple[str, str, str]
) -> list[float]:
    centres = [poses[name]["centre"] for name in anchors]
    return [
        vector_delta(centres[first], centres[second])
        for first, second in ((0, 1), (0, 2), (1, 2))
    ]


def hard_lock_report(
    before_poses: dict[str, dict[str, list[float]]],
    after_poses: dict[str, dict[str, list[float]]],
    before_intrinsics: dict[str, Any],
    after_intrinsics: dict[str, Any],
    before_identity: dict[str, Any],
    after_identity: dict[str, Any],
    anchors: tuple[str, str, str],
) -> dict[str, Any]:
    if before_poses.keys() != after_poses.keys():
        raise ValueError("Image population changed during bundle adjustment")
    rotation_delta = max(
        quaternion_delta(before_poses[name]["quaternionXyzw"], pose["quaternionXyzw"])
        for name, pose in after_poses.items()
    )
    centre_delta = max(
        vector_delta(before_poses[name]["centre"], after_poses[name]["centre"])
        for name in anchors
    )
    translation_delta = max(
        vector_delta(
            before_poses[name]["translation"], after_poses[name]["translation"]
        )
        for name in anchors
    )
    before_distances = anchor_distances(before_poses, anchors)
    after_distances = anchor_distances(after_poses, anchors)
    distance_delta = max(
        abs(before - after)
        for before, after in zip(before_distances, after_distances, strict=True)
    )
    report = {
        "epsilon": 1e-7,
        "identityUnchanged": before_identity == after_identity,
        "intrinsicsUnchanged": before_intrinsics == after_intrinsics,
        "maxRotationQuaternionComponentDelta": rotation_delta,
        "maxAnchorCentreDelta": centre_delta,
        "maxAnchorTranslationDelta": translation_delta,
        "maxAnchorDistanceDelta": distance_delta,
    }
    report["passed"] = (
        report["identityUnchanged"]
        and report["intrinsicsUnchanged"]
        and all(
            value <= report["epsilon"]
            for value in (rotation_delta, centre_delta, translation_delta, distance_delta)
        )
    )
    return report


def build_problem(
    pycolmap: Any,
    run_directory: Path,
    anchors: tuple[str, str, str],
    input_sha256: str,
    pre_ba_sha256: str,
) -> tuple[Any, Any, dict[str, Any]]:
    optimization_inputs = verify_pre_ba_bindings(
        run_directory,
        read_json(run_directory / "metrics" / "pre-ba-support.json"),
    )
    reconstruction = pycolmap.Reconstruction(
        run_directory / "models" / "triangulated"
    )
    images = image_by_name(reconstruction)
    if len(reconstruction.cameras) != 1 or len(reconstruction.rigs) != 1:
        raise ValueError("Expected exactly one camera and one rig")
    if len(reconstruction.frames) != len(images):
        raise ValueError("Expected one frame per registered image")
    missing = [name for name in anchors if name not in images]
    if missing:
        raise ValueError(f"Missing configured anchors: {missing}")
    for image in images.values():
        validate_pose(image)
        frame = reconstruction.frames[image.frame_id]
        if len(frame.image_ids) != 1 or not image.is_ref_in_frame():
            raise ValueError(f"Unexpected rig topology for {image.name}")

    config = pycolmap.BundleAdjustmentConfig()
    for image in reconstruction.images.values():
        config.add_image(image.image_id)
    anchor_mapping = []
    for name in anchors:
        image = images[name]
        config.set_constant_rig_from_world_pose(image.frame_id)
        anchor_mapping.append(
            {
                "filename": name,
                "imageId": image.image_id,
                "frameId": image.frame_id,
                "cameraId": image.camera_id,
            }
        )
    for camera_id in reconstruction.cameras:
        config.set_constant_cam_intrinsics(camera_id)

    options = pycolmap.BundleAdjustmentOptions()
    options.refine_focal_length = False
    options.refine_principal_point = False
    options.refine_extra_params = False
    options.refine_rig_from_world = True
    options.refine_sensor_from_rig = False
    options.constant_rig_from_world_rotation = True
    options.refine_points3D = True

    linked_observations = sum(
        1
        for image in reconstruction.images.values()
        for point in image.points2D
        if point.has_point3D()
    )
    scalar_residuals = config.num_residuals(reconstruction)
    if scalar_residuals != linked_observations * 2:
        raise ValueError("Configured residuals do not match linked observations")
    residual_observations = sorted(
        (
            {
                "imageId": int(element.image_id),
                "point2DIndex": int(element.point2D_idx),
                "point3DId": int(point_id),
            }
            for point_id, point in reconstruction.points3D.items()
            for element in point.track.elements
        ),
        key=lambda entry: (entry["imageId"], entry["point2DIndex"], entry["point3DId"]),
    )
    if len(residual_observations) != linked_observations:
        raise ValueError("Residual observation inventory is incomplete")
    reconstruction_image_ids = sorted(
        int(image.image_id) for image in reconstruction.images.values()
    )
    adjuster = pycolmap.create_default_bundle_adjuster(
        options, config, reconstruction
    )

    fixed_poses = config.num_constant_rig_from_world_poses()
    details = {
        "schemaVersion": 1,
        "solveCalled": False,
        "inputSha256": input_sha256,
        "preBaSupportSha256": pre_ba_sha256,
        "optimizationInputs": optimization_inputs,
        "driverSha256": sha256_file(Path(__file__)),
        **runtime_identity(pycolmap),
        "registeredImageCount": len(images),
        "fixedFullPoseFrameCount": fixed_poses,
        "fixedRotationFrameCount": len(reconstruction.frames),
        "variableTranslationFrameCount": len(reconstruction.frames) - fixed_poses,
        "fixedIntrinsicsCameraCount": config.num_constant_cam_intrinsics(),
        "linkedObservationCount": linked_observations,
        "scalarReprojectionResidualCount": scalar_residuals,
        "residualSelection": {
            "method": "pycolmap-config-num-residuals-v2",
            "nativeApi": "BundleAdjustmentConfig.num_residuals",
            "configuredImageIds": reconstruction_image_ids,
            "reconstructionImageIds": reconstruction_image_ids,
            "linkedObservationCount": linked_observations,
            "expectedScalarResidualCount": linked_observations * 2,
            "nativeScalarResidualCount": scalar_residuals,
            "identityProof": {
                "status": "unavailable",
                "reason": "PyCOLMAP exposes the selected residual count, not residual identities",
            },
            "observationIdentities": residual_observations,
        },
        "anchors": anchor_mapping,
        "effectiveConfig": config.summary(),
        "effectiveOptions": options.summary(),
    }
    if fixed_poses != 3:
        raise ValueError("Expected exactly three fixed full-pose anchors")
    return reconstruction, adjuster, details


def inspect_problem(
    pycolmap: Any,
    run_directory: Path,
    anchors: tuple[str, str, str],
    input_sha256: str,
    pre_ba_sha256: str,
) -> dict[str, Any]:
    return build_problem(
        pycolmap, run_directory, anchors, input_sha256, pre_ba_sha256
    )[2]


def has_verified_identity_proof(details: dict[str, Any]) -> bool:
    selection = details.get("residualSelection")
    proof = selection.get("identityProof") if isinstance(selection, dict) else None
    return (
        isinstance(proof, dict)
        and proof.get("status") == "verified"
        and proof.get("method") == "native-residual-identity-inventory-v1"
        and proof.get("pycolmapBinaryHashes") == details.get("pycolmapBinaryHashes")
    )


def solve_problem(
    pycolmap: Any,
    run_directory: Path,
    anchors: tuple[str, str, str],
    args: argparse.Namespace,
) -> dict[str, Any]:
    inspection_path = run_directory / "evidence" / "ba-inspection.json"
    attempt_path = run_directory / "evidence" / "ba-attempt.json"
    native_start_path = run_directory / "evidence" / "ba-native-start.json"
    binary_output = run_directory / "models" / "adjusted"
    text_output = run_directory / "exports" / "adjusted"
    pending_binary = run_directory / "models" / f".adjusted.pending-{os.getpid()}"
    pending_text = run_directory / "exports" / f".adjusted.pending-{os.getpid()}"
    for path in (
        Path(args.report),
        binary_output,
        text_output,
        pending_binary,
        pending_text,
        native_start_path,
    ):
        if path.exists():
            raise FileExistsError(f"BA execution artifact already exists: {path}")
    if sha256_file(inspection_path) != args.inspection_sha256:
        raise ValueError("BA inspection hash differs from the solve request")
    if sha256_file(attempt_path) != args.attempt_sha256:
        raise ValueError("BA attempt hash differs from the solve request")
    if sha256_file(run_directory / "resolved-config.json") != args.resolved_config_sha256:
        raise ValueError("Resolved configuration differs from the solve request")
    attempt = read_json(attempt_path)
    expected_attempt = {
        "schemaVersion": 1,
        "permanent": True,
        "inputSha256": args.input_sha256,
        "preBaSha256": args.pre_ba_sha256,
        "inspectionSha256": args.inspection_sha256,
        "driverSha256": sha256_file(Path(__file__)),
        "resolvedConfigSha256": args.resolved_config_sha256,
    }
    if any(attempt.get(field) != value for field, value in expected_attempt.items()):
        raise ValueError("Permanent BA attempt is stale or incomplete")

    inspection = read_json(inspection_path)
    if not has_verified_identity_proof(inspection):
        raise ValueError("BA solve requires verified native residual-identity evidence")
    reconstruction, adjuster, details = build_problem(
        pycolmap,
        run_directory,
        anchors,
        args.input_sha256,
        args.pre_ba_sha256,
    )
    for field in (
        "pycolmapVersion",
        "pycolmapBinaryHashes",
        "registeredImageCount",
        "fixedFullPoseFrameCount",
        "fixedRotationFrameCount",
        "variableTranslationFrameCount",
        "fixedIntrinsicsCameraCount",
        "linkedObservationCount",
        "scalarReprojectionResidualCount",
        "anchors",
        "effectiveConfig",
        "effectiveOptions",
        "residualSelection",
        "optimizationInputs",
    ):
        if details[field] != inspection.get(field):
            raise ValueError(f"BA solve differs from inspected field: {field}")
    before_poses = pose_snapshot(reconstruction)
    before_intrinsics = intrinsics_snapshot(reconstruction)
    before_identity = identity_snapshot(reconstruction)
    native_start_sha256 = reserve_native_start(
        native_start_path,
        args.attempt_sha256,
        args.inspection_sha256,
    )
    started = time.perf_counter()
    summary = adjuster.solve()
    elapsed_seconds = time.perf_counter() - started
    locks = hard_lock_report(
        before_poses,
        pose_snapshot(reconstruction),
        before_intrinsics,
        intrinsics_snapshot(reconstruction),
        before_identity,
        identity_snapshot(reconstruction),
        anchors,
    )
    usable = bool(summary.is_solution_usable())
    residual_count = int(summary.num_residuals)
    result = {
        "schemaVersion": 1,
        "status": "pass" if usable and locks["passed"] else "reject",
        "solveCalled": True,
        "solutionUsable": usable,
        "inputSha256": args.input_sha256,
        "preBaSha256": args.pre_ba_sha256,
        "optimizationInputs": details["optimizationInputs"],
        "inspectionSha256": args.inspection_sha256,
        "attemptSha256": args.attempt_sha256,
        "nativeStartSha256": native_start_sha256,
        "driverSha256": sha256_file(Path(__file__)),
        "resolvedConfigSha256": args.resolved_config_sha256,
        "pycolmapBinaryHashes": details["pycolmapBinaryHashes"],
        "effectiveConfig": details["effectiveConfig"],
        "effectiveOptions": details["effectiveOptions"],
        "scalarReprojectionResidualCount": residual_count,
        "residualSelection": details["residualSelection"],
        "elapsedSeconds": elapsed_seconds,
        "termination": str(summary.termination_type),
        "briefReport": summary.brief_report(),
        "hardLocks": locks,
    }
    if (
        not usable
        or residual_count != details["scalarReprojectionResidualCount"]
        or not locks["passed"]
    ):
        write_json_once(Path(args.report), result)
        raise RuntimeError("Bundle adjustment was unusable or violated a hard lock")

    pending_binary.mkdir(parents=True)
    pending_text.mkdir(parents=True)
    reconstruction.write(pending_binary)
    reconstruction.write_text(pending_text)
    result["binaryHashes"] = file_hashes(
        pending_binary,
        ("cameras.bin", "frames.bin", "images.bin", "points3D.bin", "rigs.bin"),
    )
    result["exportHashes"] = file_hashes(
        pending_text, ("cameras.txt", "images.txt", "points3D.txt")
    )
    os.replace(pending_binary, binary_output)
    os.replace(pending_text, text_output)
    write_json_once(Path(args.report), result)
    return result


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("inspect", "solve"))
    parser.add_argument("--run-directory", required=True, type=Path)
    parser.add_argument("--anchors", nargs=3, required=True)
    parser.add_argument("--expected-pycolmap-version", required=True)
    parser.add_argument("--python-sha256", required=True)
    parser.add_argument("--input-sha256", required=True)
    parser.add_argument("--pre-ba-sha256", required=True)
    parser.add_argument("--inspection-sha256")
    parser.add_argument("--attempt-sha256")
    parser.add_argument("--resolved-config-sha256")
    parser.add_argument("--report", required=True, type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    import pycolmap

    if pycolmap.__version__ != args.expected_pycolmap_version:
        raise ValueError("PyCOLMAP version differs from configured identity")
    if sha256_file(Path(sys.executable)) != args.python_sha256:
        raise ValueError("Python executable differs from configured identity")
    run_directory = args.run_directory.resolve()
    if sha256_file(run_directory / "input" / "original.zip") != args.input_sha256:
        raise ValueError("Isolated input ZIP differs from inspection request")
    pre_ba_path = run_directory / "metrics" / "pre-ba-support.json"
    if sha256_file(pre_ba_path) != args.pre_ba_sha256:
        raise ValueError("Pre-BA evidence differs from inspection request")
    pre_ba = json.loads(pre_ba_path.read_text(encoding="utf-8"))
    if not isinstance(pre_ba, dict) or pre_ba.get("status") != "pass":
        raise ValueError("Pre-BA support gate is not passing")
    bindings = verify_pre_ba_bindings(run_directory, pre_ba)
    if bindings.get("inputSha256") != args.input_sha256:
        raise ValueError("Pre-BA evidence is bound to a different input ZIP")
    report = args.report.resolve()
    try:
        report.relative_to(run_directory)
    except ValueError as error:
        raise ValueError("BA report must stay inside the run directory") from error
    if args.mode == "inspect":
        details = inspect_problem(
            pycolmap,
            run_directory,
            tuple(args.anchors),
            args.input_sha256,
            args.pre_ba_sha256,
        )
        write_json_once(report, details)
        return 0
    for field in (
        "inspection_sha256",
        "attempt_sha256",
        "resolved_config_sha256",
    ):
        if getattr(args, field) is None:
            raise ValueError(f"solve requires --{field.replace('_', '-')}")
    solve_problem(pycolmap, run_directory, tuple(args.anchors), args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
