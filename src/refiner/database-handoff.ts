import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { PinholeCamera } from '../colmap/model.js';
import { serializeRecorderColmapText } from '../colmap/text-codec.js';
import type { RefinerPreflight } from './preflight.js';
import type { PreparedRun } from './run-directory.js';

interface DatabaseImage {
  readonly imageId: number;
  readonly name: string;
  readonly cameraId: number;
}

export async function verifyAndFreezeFeatureDatabase(
  preflight: RefinerPreflight,
  run: PreparedRun
): Promise<void> {
  const featuresPath = join(run.runDirectory, 'database', 'features.db');
  const exhaustivePath = join(run.runDirectory, 'database', 'exhaustive.db');
  const beforeSha256 = await fileSha256(featuresPath);
  const database = readFeatureDatabase(featuresPath);
  const images = verifyIdentityAndCalibration(preflight, database);

  if ((await fileSha256(featuresPath)) !== beforeSha256) {
    throw new Error('features.db changed during read-only verification.');
  }

  await materializeKnownModel(preflight, run, database, images);

  await copyFile(featuresPath, exhaustivePath, constants.COPYFILE_EXCL);
  const exhaustiveSha256 = await fileSha256(exhaustivePath);
  if (exhaustiveSha256 !== beforeSha256) {
    await rm(exhaustivePath, { force: true });
    throw new Error('exhaustive.db does not match verified features.db.');
  }

  await writeFile(
    join(run.runDirectory, 'evidence', 'database-handoff.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        featuresDatabase: {
          path: 'database/features.db',
          sha256: beforeSha256,
        },
        exhaustiveDatabase: {
          path: 'database/exhaustive.db',
          sha256: exhaustiveSha256,
        },
        images,
      },
      null,
      2
    )}\n`,
    { flag: 'wx' }
  );
}

async function materializeKnownModel(
  preflight: RefinerPreflight,
  run: PreparedRun,
  database: {
    readonly cameras: readonly PinholeCamera[];
    readonly images: readonly DatabaseImage[];
  },
  mapping: readonly {
    readonly originalImageId: number;
    readonly imageName: string;
    readonly databaseImageId: number;
    readonly originalCameraId: number;
    readonly databaseCameraId: number;
  }[]
): Promise<void> {
  const byName = new Map(mapping.map((image) => [image.imageName, image]));
  const knownModel = {
    cameras: database.cameras,
    images: preflight.dataset.model.images.map((image) => {
      const mapped = byName.get(image.name)!;
      return {
        ...image,
        imageId: mapped.databaseImageId,
        cameraId: mapped.databaseCameraId,
        observations: [],
      };
    }),
    points3D: [],
  } as const;
  const text = serializeRecorderColmapText(knownModel);
  const knownDirectory = join(run.runDirectory, 'models', 'known');
  await Promise.all([
    writeFile(join(knownDirectory, 'cameras.txt'), text.cameras, { flag: 'wx' }),
    writeFile(join(knownDirectory, 'images.txt'), text.images, { flag: 'wx' }),
    writeFile(join(knownDirectory, 'points3D.txt'), text.points3D, {
      flag: 'wx',
    }),
    writeFile(
      join(run.runDirectory, 'poses.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          images: preflight.dataset.model.images.map((image) => ({
            originalImageId: image.imageId,
            imageName: image.name,
            cameraId: image.cameraId,
            qvec: image.pose.qvec,
            tvec: image.pose.tvec,
          })),
        },
        null,
        2
      )}\n`,
      { flag: 'wx' }
    ),
  ]);
}

function readFeatureDatabase(path: string): {
  readonly cameras: readonly PinholeCamera[];
  readonly images: readonly DatabaseImage[];
} {
  const databasePath =
    process.platform === 'win32' && !path.startsWith('\\\\?\\')
      ? `\\\\?\\${resolve(path)}`
      : path;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    requireColumns(database, 'cameras', {
      camera_id: 'INTEGER',
      model: 'INTEGER',
      width: 'INTEGER',
      height: 'INTEGER',
      params: 'BLOB',
    });
    requireColumns(database, 'images', {
      image_id: 'INTEGER',
      name: 'TEXT',
      camera_id: 'INTEGER',
    });

    const cameras = database
      .prepare('SELECT camera_id, model, width, height, params FROM cameras')
      .all()
      .map(readCamera);
    const images = database
      .prepare('SELECT image_id, name, camera_id FROM images')
      .all()
      .map(readImage);
    return { cameras, images };
  } finally {
    database.close();
  }
}

function requireColumns(
  database: DatabaseSync,
  table: string,
  expected: Readonly<Record<string, string>>
): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  for (const [name, type] of Object.entries(expected)) {
    if (!columns.some((column) => column.name === name && column.type === type)) {
      throw new Error(
        `Unsupported database schema: ${table}.${name} must be ${type}.`
      );
    }
  }
}

function readCamera(row: Record<string, unknown>): PinholeCamera {
  if (
    row.model !== 1 ||
    !(row.params instanceof Uint8Array) ||
    row.params.byteLength !== 32
  ) {
    throw new Error(
      `database camera ${String(row.camera_id)} must be PINHOLE with four float64 parameters.`
    );
  }
  const view = new DataView(
    row.params.buffer,
    row.params.byteOffset,
    row.params.byteLength
  );
  const [fx, fy, cx, cy] = [0, 8, 16, 24].map((offset) =>
    view.getFloat64(offset, true)
  );
  if (
    fx === undefined ||
    fy === undefined ||
    cx === undefined ||
    cy === undefined ||
    ![fx, fy, cx, cy].every(Number.isFinite) ||
    fx <= 0 ||
    fy <= 0
  ) {
    throw new Error('database camera has invalid PINHOLE calibration.');
  }
  return {
    cameraId: positiveId(row.camera_id, 'database camera ID'),
    model: 'PINHOLE',
    width: positiveId(row.width, 'database camera width'),
    height: positiveId(row.height, 'database camera height'),
    intrinsics: { fx, fy, cx, cy },
  };
}

function readImage(row: Record<string, unknown>): DatabaseImage {
  if (typeof row.name !== 'string' || row.name.length === 0) {
    throw new Error('database image name must be non-empty text.');
  }
  return {
    imageId: positiveId(row.image_id, 'database image ID', 2_147_483_646),
    name: row.name,
    cameraId: positiveId(row.camera_id, 'database camera ID'),
  };
}

function verifyIdentityAndCalibration(
  preflight: RefinerPreflight,
  database: {
    readonly cameras: readonly PinholeCamera[];
    readonly images: readonly DatabaseImage[];
  }
) {
  const model = preflight.dataset.model;
  const originalNames = model.images.map((image) => image.name);
  const databaseNames = database.images.map((image) => image.name);
  if (
    databaseNames.length !== originalNames.length ||
    new Set(databaseNames).size !== databaseNames.length ||
    originalNames.some((name) => !databaseNames.includes(name))
  ) {
    throw new Error(
      'database filenames must exactly match recorder filenames case-sensitively.'
    );
  }
  requireUniqueIds(
    database.images.map((image) => image.imageId),
    'database image IDs'
  );
  requireUniqueIds(
    database.cameras.map((camera) => camera.cameraId),
    'database camera IDs'
  );

  const [originalCamera] = model.cameras;
  const [databaseCamera] = database.cameras;
  if (
    originalCamera === undefined ||
    model.cameras.length !== 1 ||
    databaseCamera === undefined ||
    database.cameras.length !== 1 ||
    !sameCalibration(originalCamera, databaseCamera)
  ) {
    throw new Error('database camera must exactly match recorder calibration.');
  }

  const byName = new Map(database.images.map((image) => [image.name, image]));
  return model.images.map((image) => {
    const mapped = byName.get(image.name)!;
    if (mapped.cameraId !== databaseCamera.cameraId) {
      throw new Error(
        `database image ${image.name} references an unexpected camera.`
      );
    }
    return {
      originalImageId: image.imageId,
      imageName: image.name,
      databaseImageId: mapped.imageId,
      originalCameraId: image.cameraId,
      databaseCameraId: mapped.cameraId,
    };
  });
}

function sameCalibration(a: PinholeCamera, b: PinholeCamera): boolean {
  return (
    a.model === b.model &&
    a.width === b.width &&
    a.height === b.height &&
    a.intrinsics.fx === b.intrinsics.fx &&
    a.intrinsics.fy === b.intrinsics.fy &&
    a.intrinsics.cx === b.intrinsics.cx &&
    a.intrinsics.cy === b.intrinsics.cy
  );
}

function positiveId(
  value: unknown,
  field: string,
  max = Number.MAX_SAFE_INTEGER
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > max
  ) {
    throw new Error(`${field} must be a positive safe integer <= ${max}.`);
  }
  return value;
}

function requireUniqueIds(ids: readonly number[], field: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${field} must be unique.`);
  }
}

async function fileSha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
