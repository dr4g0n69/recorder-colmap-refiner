"""Inspect the exact three-anchor PyCOLMAP bundle-adjustment problem without solving."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path
from typing import Any


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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


def inspect_problem(
    pycolmap: Any,
    run_directory: Path,
    anchors: tuple[str, str, str],
    input_sha256: str,
    pre_ba_sha256: str,
) -> dict[str, Any]:
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
    pycolmap.create_default_bundle_adjuster(options, config, reconstruction)

    fixed_poses = config.num_constant_rig_from_world_poses()
    details = {
        "schemaVersion": 1,
        "solveCalled": False,
        "inputSha256": input_sha256,
        "preBaSupportSha256": pre_ba_sha256,
        "driverSha256": sha256_file(Path(__file__)),
        **runtime_identity(pycolmap),
        "registeredImageCount": len(images),
        "fixedFullPoseFrameCount": fixed_poses,
        "fixedRotationFrameCount": len(reconstruction.frames),
        "variableTranslationFrameCount": len(reconstruction.frames) - fixed_poses,
        "fixedIntrinsicsCameraCount": config.num_constant_cam_intrinsics(),
        "linkedObservationCount": linked_observations,
        "scalarReprojectionResidualCount": scalar_residuals,
        "anchors": anchor_mapping,
        "effectiveConfig": config.summary(),
        "effectiveOptions": options.summary(),
    }
    if fixed_poses != 3:
        raise ValueError("Expected exactly three fixed full-pose anchors")
    return details


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("inspect",))
    parser.add_argument("--run-directory", required=True, type=Path)
    parser.add_argument("--anchors", nargs=3, required=True)
    parser.add_argument("--expected-pycolmap-version", required=True)
    parser.add_argument("--python-sha256", required=True)
    parser.add_argument("--input-sha256", required=True)
    parser.add_argument("--pre-ba-sha256", required=True)
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
    report = args.report.resolve()
    try:
        report.relative_to(run_directory)
    except ValueError as error:
        raise ValueError("Inspection report must stay inside the run directory") from error
    details = inspect_problem(
        pycolmap,
        run_directory,
        tuple(args.anchors),
        args.input_sha256,
        args.pre_ba_sha256,
    )
    report.parent.mkdir(parents=True, exist_ok=True)
    with report.open("x", encoding="utf-8", newline="\n") as output:
        json.dump(details, output, indent=2)
        output.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
