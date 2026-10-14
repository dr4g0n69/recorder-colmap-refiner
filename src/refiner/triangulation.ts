import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseRecorderColmapText } from '../colmap/text-codec.js';
import {
  modelConversionCommand,
  triangulationCommand,
} from './colmap-commands.js';
import {
  executeNativeCommand,
  type NativeCommandExecutor,
} from './native-command.js';
import type { RefinerPreflight } from './preflight.js';
import type { PreparedRun } from './run-directory.js';

interface WorkingImage {
  readonly imageId: number;
  readonly cameraId: number;
  readonly name: string;
  readonly qvec: readonly number[];
  readonly tvec: readonly number[];
  readonly linkedObservations: number;
}

export async function runFixedPoseTriangulation(
  preflight: RefinerPreflight,
  run: PreparedRun,
  executor: NativeCommandExecutor
): Promise<void> {
  const logsDirectory = join(run.runDirectory, 'logs');
  await executeNativeCommand(
    triangulationCommand(
      preflight.config.colmap.executable,
      run.runDirectory,
      'database/exhaustive.db'
    ),
    executor,
    logsDirectory,
    3
  );
  await executeNativeCommand(
    modelConversionCommand(
      preflight.config.colmap.executable,
      run.runDirectory
    ),
    executor,
    logsDirectory,
    4
  );

  const knownDirectory = join(run.runDirectory, 'models', 'known');
  const exportDirectory = join(run.runDirectory, 'exports', 'triangulated');
  const known = parseRecorderColmapText({
    cameras: await readFile(join(knownDirectory, 'cameras.txt')),
    images: await readFile(join(knownDirectory, 'images.txt')),
    points3D: await readFile(join(knownDirectory, 'points3D.txt')),
  });
  const camerasBytes = await readFile(join(exportDirectory, 'cameras.txt'));
  const imagesBytes = await readFile(join(exportDirectory, 'images.txt'));
  const pointsBytes = await readFile(join(exportDirectory, 'points3D.txt'));
  const camera = readCamera(camerasBytes.toString());
  const images = readImages(imagesBytes.toString());
  const pointCount = readPointCount(pointsBytes.toString());

  const knownCamera = known.cameras[0]!;
  if (
    camera.cameraId !== knownCamera.cameraId ||
    camera.width !== knownCamera.width ||
    camera.height !== knownCamera.height ||
    !sameNumbers(camera.params, [
      knownCamera.intrinsics.fx,
      knownCamera.intrinsics.fy,
      knownCamera.intrinsics.cx,
      knownCamera.intrinsics.cy,
    ])
  ) {
    throw new Error('triangulation changed the verified camera calibration.');
  }

  const byName = new Map(images.map((image) => [image.name, image]));
  if (
    images.length !== known.images.length ||
    byName.size !== images.length ||
    known.images.some((image) => !byName.has(image.name))
  ) {
    throw new Error(
      'triangulation filenames must exactly match the verified known model.'
    );
  }
  for (const image of known.images) {
    const returned = byName.get(image.name)!;
    if (
      returned.imageId !== image.imageId ||
      returned.cameraId !== image.cameraId
    ) {
      throw new Error(`triangulation changed identity for ${image.name}.`);
    }
    if (
      !sameQuaternion(returned.qvec, image.pose.qvec) ||
      !sameNumbers(returned.tvec, image.pose.tvec)
    ) {
      throw new Error(`triangulation changed pose for ${image.name}.`);
    }
  }

  const observationCount = images.reduce(
    (sum, image) => sum + image.linkedObservations,
    0
  );
  if (pointCount === 0 || observationCount === 0) {
    throw new Error('triangulation produced no usable tracks.');
  }

  await writeFile(
    join(run.runDirectory, 'evidence', 'triangulation.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        imageCount: images.length,
        observationCount,
        pointCount,
        export: {
          path: 'exports/triangulated',
          files: {
            'cameras.txt': sha256(camerasBytes),
            'images.txt': sha256(imagesBytes),
            'points3D.txt': sha256(pointsBytes),
          },
        },
      },
      null,
      2
    )}\n`,
    { flag: 'wx' }
  );
}

function readCamera(source: string): {
  readonly cameraId: number;
  readonly width: number;
  readonly height: number;
  readonly params: readonly number[];
} {
  const rows = dataLines(source);
  if (rows.length !== 1) {
    throw new Error('triangulation must return exactly one camera.');
  }
  const tokens = rows[0]!.split(/\s+/);
  if (tokens.length !== 8 || tokens[1] !== 'PINHOLE') {
    throw new Error('triangulation camera must use PINHOLE calibration.');
  }
  const values = [tokens[0], tokens[2], tokens[3], ...tokens.slice(4)].map(
    Number
  );
  requireFinite(values, 'triangulation camera');
  return {
    cameraId: positiveInteger(values[0], 'triangulation camera ID'),
    width: positiveInteger(values[1], 'triangulation camera width'),
    height: positiveInteger(values[2], 'triangulation camera height'),
    params: values.slice(3),
  };
}

function readImages(source: string): readonly WorkingImage[] {
  const lines = source.split(/\r?\n/);
  const images: WorkingImage[] = [];
  for (let index = 0; index < lines.length; index++) {
    const header = lines[index]!.trim();
    if (header === '' || header.startsWith('#')) continue;
    const tokens = header.split(/\s+/);
    if (tokens.length !== 10) {
      throw new Error('triangulation image header is malformed.');
    }
    const numeric = tokens.slice(0, 9).map(Number);
    requireFinite(numeric, 'triangulation image header');
    const observationLine = lines[++index];
    if (observationLine === undefined) {
      throw new Error('triangulation image lacks an observation row.');
    }
    const observations =
      observationLine.trim() === ''
        ? []
        : observationLine.trim().split(/\s+/).map(Number);
    requireFinite(observations, 'triangulation observations');
    if (observations.length % 3 !== 0) {
      throw new Error('triangulation observation row is malformed.');
    }
    let linkedObservations = 0;
    for (let offset = 2; offset < observations.length; offset += 3) {
      const pointId = observations[offset]!;
      if (!Number.isSafeInteger(pointId) || pointId < -1) {
        throw new Error('triangulation observation has an invalid point ID.');
      }
      if (pointId !== -1) linkedObservations++;
    }
    images.push({
      imageId: positiveInteger(numeric[0], 'triangulation image ID'),
      qvec: numeric.slice(1, 5),
      tvec: numeric.slice(5, 8),
      cameraId: positiveInteger(numeric[8], 'triangulation camera ID'),
      name: tokens[9]!,
      linkedObservations,
    });
  }
  return images;
}

function readPointCount(source: string): number {
  const rows = dataLines(source);
  for (const row of rows) {
    const tokens = row.split(/\s+/);
    const values = tokens.map(Number);
    requireFinite(values, 'triangulation point');
    if (tokens.length < 12 || (tokens.length - 8) % 2 !== 0) {
      throw new Error('triangulation point track is malformed.');
    }
    positiveInteger(values[0], 'triangulation point ID');
  }
  return rows.length;
}

function dataLines(source: string): readonly string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

function sameQuaternion(
  left: readonly number[],
  right: readonly number[]
): boolean {
  const dot = left.reduce(
    (sum, value, index) => sum + value * right[index]!,
    0
  );
  const sign = dot < 0 ? -1 : 1;
  return sameNumbers(
    left,
    right.map((value) => sign * value)
  );
}

function sameNumbers(left: readonly number[], right: readonly number[]) {
  return (
    left.length === right.length &&
    left.every(
      (value, index) =>
        Math.abs(value - right[index]!) <=
        Math.max(1e-12, 1e-12 * Math.max(Math.abs(value), Math.abs(right[index]!)))
    )
  );
}

function positiveInteger(value: number | undefined, field: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer.`);
  }
  return value;
}

function requireFinite(values: readonly number[], field: string): void {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error(`${field} contains a non-finite value.`);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
