import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  exactlyPreserved,
  readRecorderZip,
  semanticallyEqual,
  writeRecorderZip,
  type RecorderColmapModel,
} from '../colmap/index.js';
import { recorderZipAdapter } from '../colmap/recorder-zip-adapter.js';
import { acceptancePolicy } from './acceptance-policy.js';
import type { RefinerPreflight } from './preflight.js';
import type { PreparedRun } from './run-directory.js';
import { evaluatePoseSafety, type PoseSafetyModel } from './post-ba-safety.js';
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
  const outputDirectory = join(run.runDirectory, 'output');
  const outputPath = join(outputDirectory, 'candidate.zip');
  const reportPath = join(outputDirectory, 'transfer.json');
  const publicationPath = join(
    run.runDirectory,
    'evidence',
    'zip-publication-attempt.json'
  );
  if (
    (await exists(outputDirectory)) ||
    (await exists(publicationPath))
  ) {
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
  if (JSON.stringify(report.policy) !== JSON.stringify(acceptancePolicy)) {
    throw new Error('Post-BA safety policy is not the frozen policy.');
  }
  const bindings = requireRecord(report.bindings, 'Post-BA safety bindings');
  if (bindings.inputSha256 !== preflight.inputSha256) {
    throw new Error('Post-BA safety report is bound to a different input ZIP.');
  }
  await verifyTransferBindings(run, bindings);
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
  const reopenedPoseSafety = evaluatePoseSafety(
    preflight,
    recorderPoseModel(preflight.dataset.model),
    recorderPoseModel(reopened.model)
  );
  if (reopenedPoseSafety.violations.length > 0) {
    throw new Error(
      `Reopened ZIP failed pose/frame safety: ${reopenedPoseSafety.violations[0]}`
    );
  }
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
      reopenedPoseFrameScaleSafety: true,
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
  const transferText = `${JSON.stringify(transferReport, null, 2)}\n`;
  const completionText = `${JSON.stringify(
    {
      schemaVersion: 1,
      completedAt: new Date().toISOString(),
      stage: 'zip-transfer',
      outcome: 'Delivered',
      reason: 'Candidate ZIP published and verified.',
      candidateSha256,
      transferReportSha256: sha256(Buffer.from(transferText)),
    },
    null,
    2
  )}\n`;

  const temporaryDirectory = join(
    run.runDirectory,
    `.output-pending-${randomUUID()}`
  );
  await mkdir(temporaryDirectory);
  const temporaryPath = join(temporaryDirectory, 'candidate.zip');
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
    await Promise.all([
      writeFile(join(temporaryDirectory, 'transfer.json'), transferText, {
        flag: 'wx',
      }),
      writeFile(join(temporaryDirectory, 'run-result.json'), completionText, {
        flag: 'wx',
      }),
    ]);
    await writeFile(
      publicationPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          permanent: true,
          candidateSha256,
          postBaSafetySha256: transferReport.postBaSafetySha256,
          transferReportSha256: sha256(Buffer.from(transferText)),
          completionSha256: sha256(Buffer.from(completionText)),
        },
        null,
        2
      )}\n`,
      { flag: 'wx' }
    );
    await rename(temporaryDirectory, outputDirectory);
    published = true;
    if (sha256(await readFile(outputPath)) !== candidateSha256) {
      throw new Error('Published candidate ZIP hash mismatch.');
    }
  } catch (error) {
    if (published) {
      await rm(outputDirectory, { force: true, recursive: true }).catch(
        () => undefined
      );
    }
    throw error;
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true }).catch(
      () => undefined
    );
  }
  return { outputPath, reportPath };
}

async function verifyTransferBindings(
  run: PreparedRun,
  safetyBindings: Record<string, unknown>
): Promise<void> {
  const preBaPath = join(run.runDirectory, 'metrics', 'pre-ba-support.json');
  const correspondencesPath = join(
    run.runDirectory,
    'metrics',
    'correspondences.json'
  );
  const [preBaBytes, correspondenceBytes] = await Promise.all([
    readFile(preBaPath),
    readFile(correspondencesPath),
  ]);
  if (
    safetyBindings.preBaSupportSha256 !== sha256(preBaBytes) ||
    safetyBindings.correspondencesSha256 !== sha256(correspondenceBytes)
  ) {
    throw new Error('Post-BA safety bindings changed before transfer.');
  }
  const preBa = requireRecord(
    JSON.parse(preBaBytes.toString('utf8')),
    'Pre-BA support'
  );
  if (JSON.stringify(preBa.policy) !== JSON.stringify(acceptancePolicy)) {
    throw new Error('Frozen pre-BA policy changed before transfer.');
  }
  const frozen = requireRecord(preBa.bindings, 'Pre-BA bindings');
  if (JSON.stringify(safetyBindings.optimizationInputs) !== JSON.stringify(frozen)) {
    throw new Error('Post-BA optimization-input bindings are stale.');
  }
  const database = requireRecord(frozen.matchingDatabase, 'Matching database binding');
  const model = requireRecord(frozen.triangulatedModel, 'Triangulated model binding');
  const binaryModel = requireRecord(
    frozen.triangulatedBinaryModel,
    'Triangulated binary model binding'
  );
  if (typeof database.path !== 'string' || typeof database.sha256 !== 'string') {
    throw new Error('Matching database binding is malformed.');
  }
  const databasePath = resolve(run.runDirectory, database.path);
  const databaseRelative = relative(run.runDirectory, databasePath);
  if (
    databaseRelative.startsWith('..') ||
    isAbsolute(databaseRelative) ||
    database.sha256 !== sha256(await readFile(databasePath))
  ) {
    throw new Error('Frozen matching database changed before transfer.');
  }
  for (const filename of ['cameras.txt', 'images.txt', 'points3D.txt']) {
    if (
      model[filename] !==
      sha256(
        await readFile(
          join(run.runDirectory, 'exports', 'triangulated', filename)
        )
      )
    ) {
      throw new Error(`Frozen triangulated ${filename} changed before transfer.`);
    }
  }
  for (const filename of [
    'cameras.bin',
    'frames.bin',
    'images.bin',
    'points3D.bin',
    'rigs.bin',
  ]) {
    if (
      binaryModel[filename] !==
      sha256(
        await readFile(
          join(run.runDirectory, 'models', 'triangulated', filename)
        )
      )
    ) {
      throw new Error(`Frozen triangulated ${filename} changed before transfer.`);
    }
  }
}

function recorderPoseModel(model: RecorderColmapModel): PoseSafetyModel {
  return {
    images: model.images.map((image) => ({
      imageId: image.imageId,
      cameraId: image.cameraId,
      name: image.name,
      qvec: image.pose.qvec,
      tvec: image.pose.tvec,
      observations: [],
    })),
  };
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
