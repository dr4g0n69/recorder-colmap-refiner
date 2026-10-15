import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  copyFile,
  open,
  readFile,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  exactlyPreserved,
  readRecorderZip,
  semanticallyEqual,
  writeRecorderZip,
  type RecorderColmapModel,
} from '../colmap/index.js';
import { recorderZipAdapter } from '../colmap/recorder-zip-adapter.js';
import type { RefinerPreflight } from './preflight.js';
import type { PreparedRun } from './run-directory.js';
import { readWorkingCamera, readWorkingImages } from './triangulation.js';

const modelPaths = new Set([
  'sparse/0/cameras.txt',
  'sparse/0/images.txt',
  'sparse/0/points3D.txt',
]);

export async function transferAcceptedCandidate(
  preflight: RefinerPreflight,
  run: PreparedRun
): Promise<{ readonly outputPath: string; readonly reportPath: string }> {
  const metricsDirectory = join(run.runDirectory, 'metrics');
  const outputPath = join(run.runDirectory, 'output', 'candidate.zip');
  const reportPath = join(metricsDirectory, 'transfer.json');
  if ((await exists(outputPath)) || (await exists(reportPath))) {
    throw new Error('Transfer output already exists.');
  }
  const safetyBytes = await readFile(
    join(metricsDirectory, 'post-ba-safety.json')
  );
  const report: unknown = JSON.parse(safetyBytes.toString('utf8'));
  if (
    !isRecord(report) ||
    report.verdict !== 'Pass' ||
    report.finalAcceptance !== false ||
    report.nextRequiredGate !== 'ZIP transfer and reopen verification'
  ) {
    throw new Error('Transfer requires a passing post-BA geometry verdict.');
  }
  const safetyPolicy = requireRecord(report.policy, 'Post-BA safety policy');
  if (
    safetyPolicy.version !== 'team6-post-ba-v1' ||
    safetyPolicy.protectedGeometryVersion !== 'protected-geometry-v1'
  ) {
    throw new Error('Post-BA safety policy version is not accepted.');
  }
  const bindings = requireRecord(report.bindings, 'Post-BA safety bindings');
  if (bindings.inputSha256 !== preflight.inputSha256) {
    throw new Error('Post-BA safety report is bound to a different input ZIP.');
  }
  const isolatedInputPath = join(run.runDirectory, 'input', 'original.zip');
  const isolatedInput = await readFile(isolatedInputPath);
  if (
    sha256(isolatedInput) !== preflight.inputSha256 ||
    sha256(preflight.inputZipBytes) !== preflight.inputSha256
  ) {
    throw new Error('Original ZIP changed before transfer.');
  }
  const baBytes = await readFile(
    join(run.runDirectory, 'evidence', 'ba-result.json')
  );
  if (bindings.baResultSha256 !== sha256(baBytes)) {
    throw new Error('Post-BA safety report is stale for the BA result.');
  }
  const baResult = requireRecord(
    JSON.parse(baBytes.toString('utf8')),
    'BA result'
  );
  if (baResult.status !== 'pass') {
    throw new Error('BA result is not accepted for transfer.');
  }
  const exportHashes = requireRecord(baResult.exportHashes, 'BA export hashes');
  const adjustedDirectory = join(run.runDirectory, 'exports', 'adjusted');
  const [cameraBytes, imageBytes, pointBytes] = await Promise.all([
    readFile(join(adjustedDirectory, 'cameras.txt')),
    readFile(join(adjustedDirectory, 'images.txt')),
    readFile(join(adjustedDirectory, 'points3D.txt')),
  ]);
  for (const [filename, bytes] of [
    ['cameras.txt', cameraBytes],
    ['images.txt', imageBytes],
    ['points3D.txt', pointBytes],
  ] as const) {
    if (exportHashes[filename] !== sha256(bytes)) {
      throw new Error(`Adjusted export hash mismatch for ${filename}.`);
    }
  }

  const workingCamera = readWorkingCamera(cameraBytes.toString('utf8'));
  const workingImages = readWorkingImages(imageBytes.toString('utf8'));
  const candidate = poseOnlyModel(
    preflight.dataset.model,
    workingCamera,
    workingImages
  );
  requirePoseOnlyMutation(preflight.dataset.model, candidate);
  const output = await writeRecorderZip(preflight.dataset, candidate);
  const reopened = await readRecorderZip(output);
  requireEqual(
    semanticallyEqual(candidate, reopened.model),
    'Reopened ZIP differs from the approved candidate'
  );
  requirePoseOnlyMutation(preflight.dataset.model, reopened.model);
  const nonModelEntries = await verifyArchivePreservation(
    preflight.inputZipBytes,
    output
  );
  const candidateSha256 = sha256(output);
  const transferReport = {
    schemaVersion: 1,
    status: 'pass',
    inputSha256: preflight.inputSha256,
    postBaSafetySha256: sha256(safetyBytes),
    candidateSha256,
    outputPath: resolve(outputPath),
    finalAcceptanceEvaluated: false,
    verification: {
      poseOnlyMutation: true,
      reopenedSemanticCandidate: true,
      untouchedArchiveEntries: true,
      nonModelEntries,
      mapping: candidate.images.map((image, index) => ({
        originalImageId: preflight.dataset.model.images[index]!.imageId,
        exactFilename: image.name,
        returnedImageId: workingImages.find(
          (entry) => entry.name === image.name
        )!.imageId,
        approvedPose: image.pose,
        reopenedPose: reopened.model.images[index]!.pose,
      })),
    },
  } as const;

  const temporaryPath = join(
    run.runDirectory,
    'output',
    `.candidate-${randomUUID()}.tmp`
  );
  const temporary = await open(temporaryPath, 'wx');
  let published = false;
  try {
    try {
      await temporary.writeFile(output);
    } finally {
      await temporary.close();
    }
    if (sha256(await readFile(temporaryPath)) !== candidateSha256) {
      throw new Error('Staged candidate ZIP hash mismatch.');
    }
    if (sha256(await readFile(isolatedInputPath)) !== preflight.inputSha256) {
      throw new Error('Original ZIP changed during transfer.');
    }
    await copyFile(temporaryPath, outputPath, constants.COPYFILE_EXCL);
    published = true;
    if (sha256(await readFile(outputPath)) !== candidateSha256) {
      throw new Error('Published candidate ZIP hash mismatch.');
    }
    await writeFile(
      reportPath,
      `${JSON.stringify(transferReport, null, 2)}\n`,
      { flag: 'wx' }
    );
  } catch (error) {
    if (published) await unlink(outputPath).catch(() => undefined);
    throw error;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return { outputPath, reportPath };
}

function poseOnlyModel(
  original: RecorderColmapModel,
  workingCamera: ReturnType<typeof readWorkingCamera>,
  workingImages: ReturnType<typeof readWorkingImages>
): RecorderColmapModel {
  if (
    original.cameras.length !== 1 ||
    workingCamera.width !== original.cameras[0]!.width ||
    workingCamera.height !== original.cameras[0]!.height ||
    !sameNumbers(workingCamera.params, [
      original.cameras[0]!.intrinsics.fx,
      original.cameras[0]!.intrinsics.fy,
      original.cameras[0]!.intrinsics.cx,
      original.cameras[0]!.intrinsics.cy,
    ])
  ) {
    throw new Error('Candidate camera calibration differs from the recorder.');
  }
  const byName = new Map(workingImages.map((image) => [image.name, image]));
  if (
    byName.size !== workingImages.length ||
    workingImages.length !== original.images.length ||
    original.images.some((image) => !byName.has(image.name))
  ) {
    throw new Error('Candidate image population differs from the recorder.');
  }
  return {
    ...original,
    images: original.images.map((image) => {
      const working = byName.get(image.name)!;
      requirePose(working.qvec, working.tvec, image.name);
      return {
        ...image,
        pose: {
          qvec: [
            working.qvec[0]!,
            working.qvec[1]!,
            working.qvec[2]!,
            working.qvec[3]!,
          ],
          tvec: [working.tvec[0]!, working.tvec[1]!, working.tvec[2]!],
        },
      };
    }),
  };
}

function requirePoseOnlyMutation(
  original: RecorderColmapModel,
  candidate: RecorderColmapModel
): void {
  if (
    original.images.some((image) => image.observations.length !== 0) ||
    original.points3D.some((point) => point.track.length !== 0)
  ) {
    throw new Error('Recorder observations and tracks must remain empty.');
  }
  const masked: RecorderColmapModel = {
    ...candidate,
    images: candidate.images.map((image, index) => ({
      ...image,
      pose: original.images[index]!.pose,
    })),
  };
  requireEqual(
    exactlyPreserved(original, masked),
    'Candidate changed non-pose recorder data'
  );
}

async function verifyArchivePreservation(
  beforeBytes: Uint8Array,
  afterBytes: Uint8Array
) {
  const [before, after] = await Promise.all([
    recorderZipAdapter.open(beforeBytes),
    recorderZipAdapter.open(afterBytes),
  ]);
  const afterByPath = new Map(
    after.entries.map((entry) => [entry.path, entry])
  );
  if (before.entries.length !== after.entries.length) {
    throw new Error('Candidate ZIP entry population changed.');
  }
  const retained = [];
  for (const entry of before.entries) {
    const delivered = afterByPath.get(entry.path);
    if (delivered === undefined || delivered.kind !== entry.kind) {
      throw new Error(`Candidate ZIP entry changed: ${entry.path}.`);
    }
    if (modelPaths.has(entry.path)) continue;
    if (!sameBytes(entry.bytes, delivered.bytes)) {
      throw new Error(`Candidate ZIP payload changed: ${entry.path}.`);
    }
    retained.push({
      path: entry.path,
      kind: entry.kind,
      sha256: sha256(entry.bytes),
    });
  }
  return retained;
}

function requirePose(
  qvec: readonly number[],
  tvec: readonly number[],
  imageName: string
): void {
  if (
    qvec.length !== 4 ||
    tvec.length !== 3 ||
    [...qvec, ...tvec].some((value) => !Number.isFinite(value)) ||
    Math.abs(Math.hypot(...qvec) - 1) > 1e-6
  ) {
    throw new Error(`Candidate pose is invalid for ${imageName}.`);
  }
}

function requireEqual(
  comparison: ReturnType<typeof exactlyPreserved>,
  message: string
): void {
  if (!comparison.equal) {
    throw new Error(`${message}: ${comparison.path} (${comparison.reason}).`);
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be a JSON object.`);
  return value;
}

function sameNumbers(left: readonly number[], right: readonly number[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
