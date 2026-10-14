import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RecorderColmapModel } from '../colmap/model.js';
import { recorderZipAdapter } from '../colmap/recorder-zip-adapter.js';
import { serializeRecorderColmapText } from '../colmap/text-codec.js';
import type { RefinerPreflight } from './preflight.js';
import type { PreparedRun } from './run-directory.js';

const workspaceDirectories = [
  'input',
  'images',
  'database',
  'models/known',
  'models/triangulated',
  'models/adjusted',
  'exports/triangulated',
  'exports/adjusted',
  'output',
  'logs',
  'metrics',
  'evidence',
] as const;

export async function materializeRunWorkspace(
  preflight: RefinerPreflight,
  run: PreparedRun
): Promise<void> {
  await Promise.all(
    workspaceDirectories.map((relativePath) =>
      mkdir(join(run.runDirectory, relativePath), { recursive: true })
    )
  );

  const copiedInputPath = join(run.runDirectory, 'input', 'original.zip');
  await writeFile(copiedInputPath, preflight.inputZipBytes, { flag: 'wx' });
  const copiedHash = createHash('sha256')
    .update(await readFile(copiedInputPath))
    .digest('hex');
  if (copiedHash !== preflight.inputSha256) {
    throw new Error('Copied input ZIP failed SHA-256 verification.');
  }

  const archive = await recorderZipAdapter.open(preflight.inputZipBytes);
  const images = recorderZipAdapter.resolveImages(
    archive,
    preflight.dataset.model.images
  );
  await Promise.all(
    images.map((image) =>
      writeFile(join(run.runDirectory, image.path), image.bytes, { flag: 'wx' })
    )
  );

  const knownModel = knownPoseModel(preflight.dataset.model);
  const knownText = serializeRecorderColmapText(knownModel);
  const knownDirectory = join(run.runDirectory, 'models', 'known');
  await Promise.all([
    writeFile(join(knownDirectory, 'cameras.txt'), knownText.cameras, {
      flag: 'wx',
    }),
    writeFile(join(knownDirectory, 'images.txt'), knownText.images, {
      flag: 'wx',
    }),
    writeFile(join(knownDirectory, 'points3D.txt'), knownText.points3D, {
      flag: 'wx',
    }),
    writeFile(
      join(run.runDirectory, 'poses.json'),
      `${JSON.stringify(poseRecord(knownModel), null, 2)}\n`,
      { flag: 'wx' }
    ),
  ]);
}

function knownPoseModel(model: RecorderColmapModel): RecorderColmapModel {
  return {
    cameras: model.cameras,
    images: model.images.map((image) => ({ ...image, observations: [] })),
    points3D: [],
  };
}

function poseRecord(model: RecorderColmapModel): unknown {
  return {
    schemaVersion: 1,
    images: model.images.map((image) => ({
      originalImageId: image.imageId,
      imageName: image.name,
      cameraId: image.cameraId,
      qvec: image.pose.qvec,
      tvec: image.pose.tvec,
    })),
  };
}
