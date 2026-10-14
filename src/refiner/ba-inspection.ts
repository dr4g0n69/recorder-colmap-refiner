import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  executeNativeCommand,
  type NativeCommand,
  type NativeCommandExecutor,
} from './native-command.js';
import type { RefinerPreflight } from './preflight.js';
import type { PreparedRun } from './run-directory.js';

const driverPath = fileURLToPath(
  new URL('../../scripts/three-anchor-ba.py', import.meta.url)
);

export async function inspectBundleAdjustment(
  preflight: RefinerPreflight,
  run: PreparedRun,
  executor: NativeCommandExecutor
): Promise<void> {
  const preBaPath = join(run.runDirectory, 'metrics', 'pre-ba-support.json');
  const reportPath = join(run.runDirectory, 'evidence', 'ba-inspection.json');
  const preBaSha256 = sha256(await readFile(preBaPath));
  const driverSha256 = sha256(await readFile(driverPath));
  const command: NativeCommand = {
    stage: 'ba-inspect',
    executable: preflight.config.python.executable,
    args: [
      driverPath,
      'inspect',
      '--run-directory',
      run.runDirectory,
      '--anchors',
      ...preflight.config.anchors,
      '--expected-pycolmap-version',
      preflight.config.python.pycolmapVersion,
      '--python-sha256',
      preflight.config.python.sha256,
      '--input-sha256',
      preflight.inputSha256,
      '--pre-ba-sha256',
      preBaSha256,
      '--report',
      reportPath,
    ],
    cwd: run.runDirectory,
    timeoutMs: 5 * 60 * 1000,
  };
  await executeNativeCommand(
    command,
    executor,
    join(run.runDirectory, 'logs'),
    5
  );

  const report: unknown = JSON.parse(await readFile(reportPath, 'utf8'));
  if (!isRecord(report)) {
    throw new Error('BA inspection must be a JSON object.');
  }
  if (report.solveCalled !== false) {
    throw new Error('BA inspection must not call the solver.');
  }
  if (
    report.schemaVersion !== 1 ||
    report.pycolmapVersion !== preflight.config.python.pycolmapVersion ||
    report.inputSha256 !== preflight.inputSha256 ||
    report.preBaSupportSha256 !== preBaSha256 ||
    report.driverSha256 !== driverSha256
  ) {
    throw new Error('BA inspection is stale or uses an unexpected runtime.');
  }
  const imageCount = preflight.dataset.model.images.length;
  if (
    report.registeredImageCount !== imageCount ||
    report.fixedFullPoseFrameCount !== 3 ||
    report.fixedRotationFrameCount !== imageCount ||
    report.variableTranslationFrameCount !== imageCount - 3 ||
    report.fixedIntrinsicsCameraCount !== 1 ||
    !positiveInteger(report.linkedObservationCount) ||
    report.scalarReprojectionResidualCount !==
      2 * report.linkedObservationCount
  ) {
    throw new Error('BA inspection does not match the constrained problem.');
  }
  if (
    !Array.isArray(report.anchors) ||
    report.anchors.length !== 3 ||
    report.anchors.some(
      (anchor, index) =>
        !isRecord(anchor) ||
        anchor.filename !== preflight.config.anchors[index] ||
        !positiveInteger(anchor.imageId) ||
        !positiveInteger(anchor.frameId)
    )
  ) {
    throw new Error('BA inspection anchor mapping is invalid.');
  }
  if (
    typeof report.effectiveConfig !== 'string' ||
    report.effectiveConfig.length === 0 ||
    typeof report.effectiveOptions !== 'string' ||
    report.effectiveOptions.length === 0 ||
    !isRecord(report.pycolmapBinaryHashes) ||
    Object.keys(report.pycolmapBinaryHashes).length === 0
  ) {
    throw new Error('BA inspection lacks effective settings or runtime hashes.');
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
