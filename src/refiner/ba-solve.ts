import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  executeNativeCommand,
  type NativeCommand,
  type NativeCommandExecutor,
} from './native-command.js';
import type { RefinerPreflight } from './preflight.js';
import type { PreparedRun } from './run-directory.js';
import {
  readWorkingCamera,
  readWorkingImages,
  readWorkingPoints,
} from './triangulation.js';

const driverPath = fileURLToPath(
  new URL('../../scripts/three-anchor-ba.py', import.meta.url)
);
const lockEpsilon = 1e-7;
const textFiles = ['cameras.txt', 'images.txt', 'points3D.txt'] as const;
const binaryFiles = [
  'cameras.bin',
  'frames.bin',
  'images.bin',
  'points3D.bin',
  'rigs.bin',
] as const;

export async function runBundleAdjustment(
  preflight: RefinerPreflight,
  run: PreparedRun,
  executor: NativeCommandExecutor
): Promise<void> {
  const preBaPath = join(run.runDirectory, 'metrics', 'pre-ba-support.json');
  const inspectionPath = join(run.runDirectory, 'evidence', 'ba-inspection.json');
  const attemptPath = join(run.runDirectory, 'evidence', 'ba-attempt.json');
  const reportPath = join(run.runDirectory, 'evidence', 'ba-result.json');
  const [preBaBytes, inspectionBytes, driverBytes, resolvedConfigBytes] =
    await Promise.all([
      readFile(preBaPath),
      readFile(inspectionPath),
      readFile(driverPath),
      readFile(run.resolvedConfigPath),
    ]);
  const binding = {
    inputSha256: preflight.inputSha256,
    preBaSha256: sha256(preBaBytes),
    inspectionSha256: sha256(inspectionBytes),
    driverSha256: sha256(driverBytes),
    resolvedConfigSha256: sha256(resolvedConfigBytes),
  };
  await writeFile(
    attemptPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        permanent: true,
        reservedAt: new Date().toISOString(),
        ...binding,
      },
      null,
      2
    )}\n`,
    { flag: 'wx' }
  );
  const attemptSha256 = sha256(await readFile(attemptPath));
  const command: NativeCommand = {
    stage: 'ba-solve',
    executable: preflight.config.python.executable,
    args: [
      driverPath,
      'solve',
      '--run-directory',
      run.runDirectory,
      '--anchors',
      ...preflight.config.anchors,
      '--expected-pycolmap-version',
      preflight.config.python.pycolmapVersion,
      '--python-sha256',
      preflight.config.python.sha256,
      '--input-sha256',
      binding.inputSha256,
      '--pre-ba-sha256',
      binding.preBaSha256,
      '--inspection-sha256',
      binding.inspectionSha256,
      '--attempt-sha256',
      attemptSha256,
      '--resolved-config-sha256',
      binding.resolvedConfigSha256,
      '--report',
      reportPath,
    ],
    cwd: run.runDirectory,
    timeoutMs: 2 * 60 * 60 * 1000,
  };
  await executeNativeCommand(
    command,
    executor,
    join(run.runDirectory, 'logs'),
    6
  );

  const report: unknown = JSON.parse(await readFile(reportPath, 'utf8'));
  if (!isRecord(report) || !isRecord(report.hardLocks)) {
    throw new Error('BA result must be a JSON object with hard-lock evidence.');
  }
  if (
    report.schemaVersion !== 1 ||
    report.status !== 'pass' ||
    report.solveCalled !== true ||
    report.solutionUsable !== true ||
    report.inputSha256 !== binding.inputSha256 ||
    report.preBaSha256 !== binding.preBaSha256 ||
    report.inspectionSha256 !== binding.inspectionSha256 ||
    report.driverSha256 !== binding.driverSha256 ||
    report.resolvedConfigSha256 !== binding.resolvedConfigSha256 ||
    report.attemptSha256 !== attemptSha256
  ) {
    throw new Error('BA result is failed, stale, or bound to different inputs.');
  }
  const inspection = JSON.parse(inspectionBytes.toString()) as unknown;
  if (
    !isRecord(inspection) ||
    report.scalarReprojectionResidualCount !==
      inspection.scalarReprojectionResidualCount ||
    report.effectiveConfig !== inspection.effectiveConfig ||
    report.effectiveOptions !== inspection.effectiveOptions ||
    JSON.stringify(report.pycolmapBinaryHashes) !==
      JSON.stringify(inspection.pycolmapBinaryHashes)
  ) {
    throw new Error('BA execution differs from the inspected problem.');
  }
  const locks = report.hardLocks;
  if (
    locks.passed !== true ||
    locks.identityUnchanged !== true ||
    locks.intrinsicsUnchanged !== true ||
    !withinLock(locks.maxRotationQuaternionComponentDelta) ||
    !withinLock(locks.maxAnchorCentreDelta) ||
    !withinLock(locks.maxAnchorTranslationDelta) ||
    !withinLock(locks.maxAnchorDistanceDelta)
  ) {
    throw new Error('BA execution violated an identity, pose, or scale lock.');
  }
  await verifyHashes(
    join(run.runDirectory, 'models', 'adjusted'),
    report.binaryHashes,
    binaryFiles
  );
  await verifyHashes(
    join(run.runDirectory, 'exports', 'adjusted'),
    report.exportHashes,
    textFiles
  );
  await verifyAdjustedModel(preflight, run);
}

async function verifyAdjustedModel(
  preflight: RefinerPreflight,
  run: PreparedRun
): Promise<void> {
  const baselineDirectory = join(run.runDirectory, 'exports', 'triangulated');
  const adjustedDirectory = join(run.runDirectory, 'exports', 'adjusted');
  const baselineCamera = readWorkingCamera(
    await readFile(join(baselineDirectory, 'cameras.txt'), 'utf8')
  );
  const adjustedCamera = readWorkingCamera(
    await readFile(join(adjustedDirectory, 'cameras.txt'), 'utf8')
  );
  if (JSON.stringify(baselineCamera) !== JSON.stringify(adjustedCamera)) {
    throw new Error('BA adjusted export changed camera calibration.');
  }
  const baselineImages = readWorkingImages(
    await readFile(join(baselineDirectory, 'images.txt'), 'utf8')
  );
  const adjustedImageList = readWorkingImages(
    await readFile(join(adjustedDirectory, 'images.txt'), 'utf8')
  );
  const adjustedImages = new Map(
    adjustedImageList.map((image) => [image.name, image])
  );
  if (
    adjustedImages.size !== baselineImages.length ||
    adjustedImageList.length !== baselineImages.length
  ) {
    throw new Error('BA adjusted export changed the image population.');
  }
  const anchors = new Set(preflight.config.anchors);
  for (const before of baselineImages) {
    const after = adjustedImages.get(before.name);
    if (
      after === undefined ||
      after.imageId !== before.imageId ||
      after.cameraId !== before.cameraId ||
      JSON.stringify(after.observations) !== JSON.stringify(before.observations)
    ) {
      throw new Error(`BA adjusted export changed identity for ${before.name}.`);
    }
    if (!sameQuaternion(before.qvec, after.qvec)) {
      throw new Error(`BA adjusted export changed rotation for ${before.name}.`);
    }
    if (anchors.has(before.name) && !sameVector(before.tvec, after.tvec)) {
      throw new Error(`BA adjusted export moved anchor ${before.name}.`);
    }
  }
  const baselinePoints = readWorkingPoints(
    await readFile(join(baselineDirectory, 'points3D.txt'), 'utf8')
  );
  const adjustedPointList = readWorkingPoints(
    await readFile(join(adjustedDirectory, 'points3D.txt'), 'utf8')
  );
  const adjustedPoints = new Map(
    adjustedPointList.map((point) => [point.point3DId, point])
  );
  if (
    adjustedPoints.size !== baselinePoints.length ||
    adjustedPointList.length !== baselinePoints.length
  ) {
    throw new Error('BA adjusted export changed the point population.');
  }
  for (const before of baselinePoints) {
    const after = adjustedPoints.get(before.point3DId);
    if (
      after === undefined ||
      JSON.stringify(after.track) !== JSON.stringify(before.track)
    ) {
      throw new Error(`BA adjusted export changed track ${before.point3DId}.`);
    }
  }
}

async function verifyHashes(
  directory: string,
  value: unknown,
  filenames: readonly string[]
): Promise<void> {
  if (!isRecord(value) || Object.keys(value).length !== filenames.length) {
    throw new Error('BA result has an incomplete output hash inventory.');
  }
  for (const filename of filenames) {
    const expected = value[filename];
    if (
      typeof expected !== 'string' ||
      expected !== sha256(await readFile(join(directory, filename)))
    ) {
      throw new Error(`BA output hash mismatch for ${filename}.`);
    }
  }
}

function sameQuaternion(
  left: readonly number[],
  right: readonly number[]
): boolean {
  const direct = Math.max(
    ...left.map((value, index) => Math.abs(value - right[index]!))
  );
  const negated = Math.max(
    ...left.map((value, index) => Math.abs(value + right[index]!))
  );
  return Math.min(direct, negated) <= lockEpsilon;
}

function sameVector(left: readonly number[], right: readonly number[]): boolean {
  return (
    Math.max(...left.map((value, index) => Math.abs(value - right[index]!))) <=
    lockEpsilon
  );
}

function withinLock(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value <= lockEpsilon;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
