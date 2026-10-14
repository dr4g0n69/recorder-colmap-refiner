import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { RefinerPreflight } from './preflight.js';
import type { PreparedRun } from './run-directory.js';
import {
  readWorkingImages,
  readWorkingPoints,
  type WorkingImage,
  type WorkingPoint,
} from './triangulation.js';

const policy = {
  minVerifiedMatches: 15,
  minUsableTracks: 10,
  minUsableObservations: 20,
  minParallaxDegrees: 1.5,
  depthEpsilon: 1e-6,
  coverageGridRows: 10,
  coverageGridColumns: 10,
  minCoverageEachImage: 0.05,
} as const;

interface RequiredPair {
  readonly images: readonly [string, string];
  readonly roles: readonly ('sequential' | 'loop')[];
}

interface DatabasePair {
  readonly rawMatches: number;
  readonly verified: readonly {
    readonly keypointIndices: readonly [number, number];
    readonly xy: readonly [readonly [number, number], readonly [number, number]];
  }[];
  readonly orderedImageIds: readonly [number, number];
}

export async function verifyPreBaSupport(
  preflight: RefinerPreflight,
  run: PreparedRun
): Promise<void> {
  const pairs = requiredPairs(preflight);
  const database = readDatabasePairs(
    join(run.runDirectory, 'database', 'exhaustive.db'),
    pairs
  );
  const exportDirectory = join(run.runDirectory, 'exports', 'triangulated');
  const images = readWorkingImages(
    await readFile(join(exportDirectory, 'images.txt'), 'utf8')
  );
  const points = readWorkingPoints(
    await readFile(join(exportDirectory, 'points3D.txt'), 'utf8')
  );
  verifyReciprocalTracks(images, points);

  const imageById = new Map(images.map((image) => [image.imageId, image]));
  const evidence = pairs.map((pair, index) =>
    evaluatePair(
      pair,
      database[index]!,
      imageById,
      points,
      preflight.dataset.model.cameras[0]!
    )
  );
  const edges = new Map(
    preflight.dataset.model.images.map((image) => [
      image.name,
      new Set<string>(),
    ])
  );
  for (const pair of evidence) {
    if (pair.status !== 'pass') continue;
    edges.get(pair.images[0])!.add(pair.images[1]);
    edges.get(pair.images[1])!.add(pair.images[0]);
  }
  const connectedComponents = components(edges);
  const status =
    evidence.every((pair) => pair.status === 'pass') &&
    connectedComponents.length === 1
      ? 'pass'
      : 'inconclusive';
  const report = {
    schemaVersion: 1,
    status,
    policy,
    connectedComponents,
    pairs: evidence,
    baParticipationEvaluated: false,
  } as const;
  await Promise.all([
    writeFile(
      join(run.runDirectory, 'metrics', 'pre-ba-support.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      { flag: 'wx' }
    ),
    writeFile(
      join(run.runDirectory, 'metrics', 'loop-support.md'),
      supportMarkdown(report),
      { flag: 'wx' }
    ),
    writeFile(
      join(run.runDirectory, 'metrics', 'correspondences.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          pairs: pairs.map((pair, index) => ({
            images: pair.images,
            roles: pair.roles,
            matches: database[index]!.verified,
          })),
        },
        null,
        2
      )}\n`,
      { flag: 'wx' }
    ),
  ]);

  const failed = evidence.find((pair) => pair.status !== 'pass');
  if (failed !== undefined) {
    throw new Error(
      `pre-BA support is insufficient for ${failed.images[0]} / ${failed.images[1]}.`
    );
  }
  if (connectedComponents.length !== 1) {
    throw new Error('pre-BA support does not connect every recorder image.');
  }
}

function requiredPairs(preflight: RefinerPreflight): readonly RequiredPair[] {
  const pairs = new Map<string, RequiredPair>();
  const add = (
    images: readonly [string, string],
    role: 'sequential' | 'loop'
  ) => {
    const key = [...images].sort().join('\0');
    const existing = pairs.get(key);
    pairs.set(key, {
      images: existing?.images ?? images,
      roles: existing ? [...existing.roles, role] : [role],
    });
  };
  preflight.sequentialPairs.forEach((pair) => add(pair, 'sequential'));
  preflight.config.loopPairs.forEach((pair) => add(pair, 'loop'));
  return [...pairs.values()];
}

function readDatabasePairs(
  path: string,
  pairs: readonly RequiredPair[]
): readonly DatabasePair[] {
  const databasePath =
    process.platform === 'win32' && !path.startsWith('\\\\?\\')
      ? `\\\\?\\${resolve(path)}`
      : path;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const imageIds = new Map<string, number>();
    for (const row of database.prepare('SELECT image_id, name FROM images').all()) {
      if (
        typeof row.name !== 'string' ||
        typeof row.image_id !== 'number' ||
        !Number.isSafeInteger(row.image_id) ||
        row.image_id <= 0 ||
        imageIds.has(row.name)
      ) {
        throw new Error('database image identity is invalid during support review.');
      }
      imageIds.set(row.name, row.image_id);
    }
    return pairs.map((pair) => {
      const orderedImageIds = pair.images.map((name) => imageIds.get(name)) as [
        number | undefined,
        number | undefined,
      ];
      if (orderedImageIds.some((id) => id === undefined)) {
        throw new Error('required pair image is absent from the database.');
      }
      const [first, second] = orderedImageIds as [number, number];
      const lowerFirst = first < second;
      const pairId =
        BigInt(Math.min(first, second)) * 2_147_483_647n +
        BigInt(Math.max(first, second));
      const raw = readMatchRow(database, 'matches', pairId, false);
      const verified = readMatchRow(
        database,
        'two_view_geometries',
        pairId,
        true
      );
      const keypoints = [first, second].map((imageId) =>
        readKeypoints(database, imageId)
      );
      const orderedIndices = verified.indices.map(([low, high]) =>
        lowerFirst ? ([low, high] as const) : ([high, low] as const)
      );
      return {
        rawMatches: raw.rows,
        verified: orderedIndices.map((indices) => ({
          keypointIndices: indices,
          xy: indices.map((keypointIndex, side) => {
            const xy = keypoints[side]![keypointIndex];
            if (xy === undefined) {
              throw new Error('verified match references a missing keypoint.');
            }
            return xy;
          }) as [[number, number], [number, number]],
        })),
        orderedImageIds: [first, second],
      };
    });
  } finally {
    database.close();
  }
}

function readKeypoints(
  database: DatabaseSync,
  imageId: number
): readonly (readonly [number, number])[] {
  const row = database
    .prepare('SELECT rows, cols, data FROM keypoints WHERE image_id = ?')
    .get(imageId);
  if (
    row === undefined ||
    typeof row.rows !== 'number' ||
    !Number.isSafeInteger(row.rows) ||
    row.rows < 0 ||
    typeof row.cols !== 'number' ||
    !Number.isSafeInteger(row.cols) ||
    row.cols < 2 ||
    !(row.data instanceof Uint8Array) ||
    row.data.byteLength !== row.rows * row.cols * 4
  ) {
    throw new Error('keypoints contains a malformed image row.');
  }
  const view = new DataView(
    row.data.buffer,
    row.data.byteOffset,
    row.data.byteLength
  );
  const rows = row.rows;
  const columns = row.cols;
  return Array.from({ length: rows }, (_, index) => {
    const x = view.getFloat32(index * columns * 4, true);
    const y = view.getFloat32(index * columns * 4 + 4, true);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('keypoints contains a non-finite coordinate.');
    }
    return [x, y] as const;
  });
}

function readMatchRow(
  database: DatabaseSync,
  table: 'matches' | 'two_view_geometries',
  pairId: bigint,
  decode: boolean
): { readonly rows: number; readonly indices: readonly [number, number][] } {
  const row = database
    .prepare(`SELECT rows, cols, data FROM ${table} WHERE pair_id = ?`)
    .get(pairId);
  if (row === undefined) return { rows: 0, indices: [] };
  if (
    typeof row.rows !== 'number' ||
    !Number.isSafeInteger(row.rows) ||
    row.rows < 0 ||
    row.cols !== 2 ||
    !(row.data instanceof Uint8Array) ||
    row.data.byteLength !== row.rows * 8
  ) {
    throw new Error(`${table} contains a malformed match row.`);
  }
  if (!decode) return { rows: row.rows, indices: [] };
  const view = new DataView(
    row.data.buffer,
    row.data.byteOffset,
    row.data.byteLength
  );
  const indices: [number, number][] = [];
  for (let index = 0; index < row.rows; index++) {
    indices.push([
      view.getUint32(index * 8, true),
      view.getUint32(index * 8 + 4, true),
    ]);
  }
  if (new Set(indices.map((entry) => entry.join(':'))).size !== indices.length) {
    throw new Error(`${table} contains duplicate match identities.`);
  }
  return { rows: row.rows, indices };
}

function verifyReciprocalTracks(
  images: readonly WorkingImage[],
  points: readonly WorkingPoint[]
): void {
  const imageById = new Map(images.map((image) => [image.imageId, image]));
  const pointById = new Map(points.map((point) => [point.point3DId, point]));
  if (imageById.size !== images.length || pointById.size !== points.length) {
    throw new Error('triangulated image and point IDs must be unique.');
  }
  const memberships = new Set<string>();
  for (const point of points) {
    const trackImages = new Set<number>();
    for (const member of point.track) {
      const image = imageById.get(member.imageId);
      const key = `${member.imageId}:${member.point2DIndex}`;
      if (
        image === undefined ||
        trackImages.has(member.imageId) ||
        memberships.has(key) ||
        image.observations[member.point2DIndex]?.point3DId !== point.point3DId
      ) {
        throw new Error('triangulated track lacks a reciprocal observation.');
      }
      trackImages.add(member.imageId);
      memberships.add(key);
    }
    if (trackImages.size < 2) {
      throw new Error('triangulated point must span at least two images.');
    }
  }
  for (const image of images) {
    image.observations.forEach((observation, index) => {
      if (
        observation.point3DId !== null &&
        (!pointById.has(observation.point3DId) ||
          !memberships.has(`${image.imageId}:${index}`))
      ) {
        throw new Error('triangulated observation lacks a reciprocal track.');
      }
    });
  }
}

function evaluatePair(
  pair: RequiredPair,
  database: DatabasePair,
  imageById: ReadonlyMap<number, WorkingImage>,
  points: readonly WorkingPoint[],
  camera: { readonly width: number; readonly height: number }
) {
  const [firstId, secondId] = database.orderedImageIds;
  const first = imageById.get(firstId)!;
  const second = imageById.get(secondId)!;
  const usableTrackIds: number[] = [];
  const verifiedIndices = new Set(
    database.verified.map((match) => match.keypointIndices.join(':'))
  );
  const coverageCells = [new Set<number>(), new Set<number>()];
  for (const match of database.verified) {
    match.xy.forEach(([x, y], side) => {
      if (x < 0 || x >= camera.width || y < 0 || y >= camera.height) {
        throw new Error('verified match coordinate is outside the image.');
      }
      const column = Math.min(
        policy.coverageGridColumns - 1,
        Math.floor((x * policy.coverageGridColumns) / camera.width)
      );
      const row = Math.min(
        policy.coverageGridRows - 1,
        Math.floor((y * policy.coverageGridRows) / camera.height)
      );
      coverageCells[side]!.add(row * policy.coverageGridColumns + column);
    });
  }
  const coverage = coverageCells.map(
    (cells) =>
      cells.size / (policy.coverageGridRows * policy.coverageGridColumns)
  );
  let positiveDepthCount = 0;
  let sufficientParallaxCount = 0;
  for (const point of points) {
    const firstMember = point.track.find((entry) => entry.imageId === firstId);
    const secondMember = point.track.find((entry) => entry.imageId === secondId);
    if (
      firstMember === undefined ||
      secondMember === undefined ||
      !verifiedIndices.has(
        `${firstMember.point2DIndex}:${secondMember.point2DIndex}`
      )
    ) {
      continue;
    }
    const positiveDepth =
      cameraDepth(first, point.xyz) > policy.depthEpsilon &&
      cameraDepth(second, point.xyz) > policy.depthEpsilon;
    const sufficientParallax =
      parallaxDegrees(first, second, point.xyz) >= policy.minParallaxDegrees;
    if (positiveDepth) positiveDepthCount++;
    if (sufficientParallax) sufficientParallaxCount++;
    if (positiveDepth && sufficientParallax) {
      usableTrackIds.push(point.point3DId);
    }
  }
  const usableObservationCount = usableTrackIds.length * 2;
  const status =
    database.verified.length >= policy.minVerifiedMatches &&
    coverage.every((value) => value >= policy.minCoverageEachImage) &&
    usableTrackIds.length >= policy.minUsableTracks &&
    usableObservationCount >= policy.minUsableObservations
      ? 'pass'
      : 'inconclusive';
  return {
    images: pair.images,
    roles: pair.roles,
    rawMatches: database.rawMatches,
    verifiedMatches: database.verified.length,
    coverage,
    triangulatedSharedTrackCount: usableTrackIds.length,
    positiveDepthCount,
    sufficientParallaxCount,
    usableTrackCount: usableTrackIds.length,
    usableObservationCount,
    usableTrackIds,
    status,
    baParticipation: 'not-evaluated',
  } as const;
}

function cameraDepth(image: WorkingImage, point: readonly number[]): number {
  const rotation = rotationMatrix(image.qvec);
  return (
    rotation[6]! * point[0]! +
    rotation[7]! * point[1]! +
    rotation[8]! * point[2]! +
    image.tvec[2]!
  );
}

function parallaxDegrees(
  first: WorkingImage,
  second: WorkingImage,
  point: readonly number[]
): number {
  const firstRay = subtract(point, cameraCenter(first));
  const secondRay = subtract(point, cameraCenter(second));
  const denominator = Math.hypot(...firstRay) * Math.hypot(...secondRay);
  if (!Number.isFinite(denominator) || denominator === 0) return 0;
  const cosine = Math.max(
    -1,
    Math.min(1, dot(firstRay, secondRay) / denominator)
  );
  return (Math.acos(cosine) * 180) / Math.PI;
}

function cameraCenter(image: WorkingImage): readonly number[] {
  const rotation = rotationMatrix(image.qvec);
  return [0, 1, 2].map(
    (column) =>
      -(
        rotation[column]! * image.tvec[0]! +
        rotation[3 + column]! * image.tvec[1]! +
        rotation[6 + column]! * image.tvec[2]!
      )
  );
}

function rotationMatrix(qvec: readonly number[]): readonly number[] {
  const [w, x, y, z] = qvec;
  if (
    w === undefined ||
    x === undefined ||
    y === undefined ||
    z === undefined ||
    Math.abs(Math.hypot(w, x, y, z) - 1) > 1e-6
  ) {
    throw new Error('triangulated pose has an invalid quaternion.');
  }
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - w * z),
    2 * (x * z + w * y),
    2 * (x * y + w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z - w * x),
    2 * (x * z - w * y),
    2 * (y * z + w * x),
    1 - 2 * (x * x + y * y),
  ];
}

function components(edges: ReadonlyMap<string, ReadonlySet<string>>) {
  const unseen = new Set(edges.keys());
  const result: string[][] = [];
  for (const image of edges.keys()) {
    if (!unseen.delete(image)) continue;
    const component = [image];
    for (const current of component) {
      for (const neighbor of edges.get(current)!) {
        if (unseen.delete(neighbor)) component.push(neighbor);
      }
    }
    result.push(component);
  }
  return result;
}

function supportMarkdown(report: {
  readonly status: string;
  readonly pairs: readonly {
    readonly images: readonly [string, string];
    readonly roles: readonly string[];
    readonly rawMatches: number;
    readonly verifiedMatches: number;
    readonly coverage: readonly number[];
    readonly usableTrackCount: number;
    readonly positiveDepthCount: number;
    readonly sufficientParallaxCount: number;
    readonly status: string;
  }[];
}): string {
  return `${[
    '# Pre-BA support',
    '',
    `Status: ${report.status}`,
    '',
    '| Pair | Role | Raw | Verified | Usable tracks | Coverage | Positive depth | Sufficient parallax | Status |',
    '|---|---|---:|---:|---:|---|---:|---:|---|',
    ...report.pairs.map(
      (pair) =>
        `| ${pair.images.join(' / ')} | ${pair.roles.join(', ')} | ${pair.rawMatches} | ${pair.verifiedMatches} | ${pair.usableTrackCount} | ${pair.coverage.map((value) => value.toFixed(2)).join(' / ')} | ${pair.positiveDepthCount} | ${pair.sufficientParallaxCount} | ${pair.status} |`
    ),
    '',
    'BA participation is not evaluated before optimization.',
    '',
  ].join('\n')}\n`;
}

function subtract(left: readonly number[], right: readonly number[]) {
  return left.map((value, index) => value - right[index]!);
}

function dot(left: readonly number[], right: readonly number[]) {
  return left.reduce((sum, value, index) => sum + value * right[index]!, 0);
}
