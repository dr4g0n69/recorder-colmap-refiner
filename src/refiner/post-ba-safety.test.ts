import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { RecorderDataset } from '../colmap/index.js';
import { acceptancePolicy } from './acceptance-policy.js';
import { decidePostBaVerdict, evaluatePostBaSafety } from './post-ba-safety.js';
import type { RefinerPreflight } from './preflight.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe('decidePostBaVerdict', () => {
  it('passes only complete evidence without a rejection', () => {
    expect(decidePostBaVerdict([], [])).toBe('Pass');
  });

  it('reports missing or unusable evidence as inconclusive', () => {
    expect(decidePostBaVerdict([], ['missing protected support'])).toBe(
      'Inconclusive'
    );
  });

  it('keeps demonstrated damage rejected even when evidence is also incomplete', () => {
    expect(
      decidePostBaVerdict(
        ['protected correspondence lost positive depth'],
        ['candidate metric unavailable']
      )
    ).toBe('Rejected');
  });
});

describe('evaluatePostBaSafety', () => {
  it('provisionally passes an improving pose-only candidate with intact support', async () => {
    const fixture = await safetyFixture();

    expect(await evaluatePostBaSafety(fixture.preflight, fixture.run)).toBe(
      'Pass'
    );
    expect(await readReport(fixture.run.runDirectory)).toEqual(
      expect.objectContaining({
        verdict: 'Pass',
        finalAcceptance: false,
        nextRequiredGate: 'ZIP transfer and reopen verification',
        rejections: [],
        inconclusiveReasons: [],
      })
    );
  });

  it('rejects a positive-depth BA-observation loss despite aggregate improvement', async () => {
    const fixture = await safetyFixture({ damagedPoint: true });

    expect(await evaluatePostBaSafety(fixture.preflight, fixture.run)).toBe(
      'Rejected'
    );
    expect(await readReport(fixture.run.runDirectory)).toEqual(
      expect.objectContaining({
        verdict: 'Rejected',
        rejections: expect.arrayContaining([
          expect.stringContaining(
            'Previously valid BA observations lost positive depth'
          ),
        ]),
      })
    );
  });

  it('is inconclusive when the frozen match population cannot support scoring', async () => {
    const fixture = await safetyFixture({ matchCount: 5, noImprovement: true });

    expect(await evaluatePostBaSafety(fixture.preflight, fixture.run)).toBe(
      'Inconclusive'
    );
    expect(await readReport(fixture.run.runDirectory)).toEqual(
      expect.objectContaining({
        verdict: 'Inconclusive',
        rejections: [],
        inconclusiveReasons: expect.arrayContaining([
          expect.stringContaining('Insufficient verified matches'),
        ]),
      })
    );
  });

  it('rejects demonstrated calibration corruption', async () => {
    const fixture = await safetyFixture({ changedCalibration: true });

    expect(await evaluatePostBaSafety(fixture.preflight, fixture.run)).toBe(
      'Rejected'
    );
  });

  it('is inconclusive when a frozen optimization input changes', async () => {
    const fixture = await safetyFixture();
    await writeFile(
      join(fixture.run.runDirectory, 'database', 'selected.db'),
      new Uint8Array([9, 9, 9])
    );

    expect(await evaluatePostBaSafety(fixture.preflight, fixture.run)).toBe(
      'Inconclusive'
    );
    expect(await readReport(fixture.run.runDirectory)).toEqual(
      expect.objectContaining({
        inconclusiveReasons: expect.arrayContaining([
          'Frozen matching database changed before scoring.',
        ]),
      })
    );
  });

  it('is inconclusive when the BA result is bound to stale approval evidence', async () => {
    const fixture = await safetyFixture();
    const path = join(fixture.run.runDirectory, 'evidence', 'ba-result.json');
    const result = JSON.parse(await readFile(path, 'utf8')) as Record<
      string,
      unknown
    >;
    result.inspectionSha256 = 'f'.repeat(64);
    await writeFile(path, JSON.stringify(result));

    expect(await evaluatePostBaSafety(fixture.preflight, fixture.run)).toBe(
      'Inconclusive'
    );
    expect(await readReport(fixture.run.runDirectory)).toEqual(
      expect.objectContaining({
        inconclusiveReasons: expect.arrayContaining([
          'BA result is failed, stale, or bound to different inputs.',
        ]),
      })
    );
  });

  it('is inconclusive when a protected track lacks residual participation evidence', async () => {
    const fixture = await safetyFixture();
    const path = join(
      fixture.run.runDirectory,
      'evidence',
      'ba-result.json'
    );
    const result = JSON.parse(await readFile(path, 'utf8')) as {
      residualSelection: { observationIdentities: unknown[] };
    };
    result.residualSelection.observationIdentities.shift();
    await writeFile(path, JSON.stringify(result));

    expect(await evaluatePostBaSafety(fixture.preflight, fixture.run)).toBe(
      'Inconclusive'
    );
  });

  it('is inconclusive when a complete residual inventory contains a false identity', async () => {
    const fixture = await safetyFixture({ wrongResidualIdentity: true });

    expect(await evaluatePostBaSafety(fixture.preflight, fixture.run)).toBe(
      'Inconclusive'
    );
    expect(await readReport(fixture.run.runDirectory)).toEqual(
      expect.objectContaining({
        inconclusiveReasons: expect.arrayContaining([
          'BA residual identity inventory does not exactly match linked observations.',
        ]),
      })
    );
  });

  it('is inconclusive without native residual-selection proof', async () => {
    const fixture = await safetyFixture({ missingNativeSelectionProof: true });

    expect(await evaluatePostBaSafety(fixture.preflight, fixture.run)).toBe(
      'Inconclusive'
    );
    expect(await readReport(fixture.run.runDirectory)).toEqual(
      expect.objectContaining({
        inconclusiveReasons: expect.arrayContaining([
          'BA residual-selection evidence is malformed.',
        ]),
      })
    );
  });

  it('is inconclusive when the frozen acceptance policy differs', async () => {
    const fixture = await safetyFixture({ changedPolicy: true });

    expect(await evaluatePostBaSafety(fixture.preflight, fixture.run)).toBe(
      'Inconclusive'
    );
    expect(await readReport(fixture.run.runDirectory)).toEqual(
      expect.objectContaining({
        inconclusiveReasons: [
          'Frozen pre-BA policy differs from post-BA policy.',
        ],
      })
    );
  });
});

async function safetyFixture(
  options: {
    readonly damagedPoint?: boolean;
    readonly matchCount?: number;
    readonly noImprovement?: boolean;
    readonly changedCalibration?: boolean;
    readonly wrongResidualIdentity?: boolean;
    readonly changedPolicy?: boolean;
    readonly missingNativeSelectionProof?: boolean;
  } = {}
) {
  const runDirectory = await mkdtemp(join(tmpdir(), 'post-ba-safety-'));
  temporaryDirectories.push(runDirectory);
  await Promise.all(
    [
      'metrics',
      'evidence',
      'database',
      'models/triangulated',
      'exports/triangulated',
      'exports/adjusted',
    ].map(
      (path) => mkdir(join(runDirectory, path), { recursive: true })
    )
  );
  const names = [1, 2, 3, 4].map(
    (index) => `frame-${String(index).padStart(6, '0')}.jpg`
  );
  const baselineCentres = [
    [0, 0, 0],
    [0.2, 0, 0],
    [0.4, 0, 0],
    [0.6, 0, 0],
  ] as const;
  const candidateCentres = options.noImprovement
    ? baselineCentres
    : ([...baselineCentres.slice(0, 3), [0.6, 0.03, 0] as const] as const);
  const points = Array.from(
    { length: 15 },
    (_, index) =>
      [((index % 5) - 2) * 0.4, (Math.floor(index / 5) - 1) * 0.6, 3] as const
  );
  const observed = names.map((_, imageIndex) =>
    points.map((point) => project(point, candidateCentres[imageIndex]!))
  );
  const imageIds = [11, 22, 33, 44];
  const modelText = (
    centres: readonly (readonly number[])[],
    damagePoint: boolean,
    focalLength = 500
  ) => ({
    cameras: `1 PINHOLE 640 480 ${focalLength} 500 320 240\n`,
    images: `${names
      .flatMap((name, imageIndex) => [
        `${imageIds[imageIndex]} 1 0 0 0 ${-centres[imageIndex]![0]!} ${-centres[imageIndex]![1]!} 0 1 ${name}`,
        observed[imageIndex]!.map(
          ([x, y], pointIndex) => `${x} ${y} ${pointIndex + 1}`
        ).join(' '),
      ])
      .join('\n')}\n`,
    points: `${points
      .map((point, index) => {
        const xyz =
          damagePoint && index === 0 ? [point[0], point[1], -3] : point;
        return `${index + 1} ${xyz.join(' ')} 255 0 0 0.1 ${imageIds
          .map((imageId) => `${imageId} ${index}`)
          .join(' ')}`;
      })
      .join('\n')}\n`,
  });
  const baseline = modelText(baselineCentres, false);
  const candidate = modelText(
    candidateCentres,
    options.damagedPoint === true,
    options.changedCalibration ? 501 : 500
  );
  await Promise.all(
    (['cameras', 'images', 'points'] as const).flatMap((field) => {
      const filename = field === 'points' ? 'points3D.txt' : `${field}.txt`;
      return [
        writeFile(
          join(runDirectory, 'exports', 'triangulated', filename),
          baseline[field]
        ),
        writeFile(
          join(runDirectory, 'exports', 'adjusted', filename),
          candidate[field]
        ),
      ];
    })
  );
  const sequentialPairs = names
    .slice(1)
    .map((name, index) => [names[index]!, name] as const);
  const loopPairs = [[names[0]!, names[3]!] as const];
  const required = [...sequentialPairs, ...loopPairs];
  const matchCount = options.matchCount ?? points.length;
  const correspondenceText = JSON.stringify({
      schemaVersion: 1,
      pairs: required.map((pair, pairIndex) => ({
        images: pair,
        roles: [pairIndex < sequentialPairs.length ? 'sequential' : 'loop'],
        matches: points.slice(0, matchCount).map((_, pointIndex) => ({
          keypointIndices: [pointIndex, pointIndex],
          xy: pair.map((name) => observed[names.indexOf(name)]![pointIndex]!),
        })),
      })),
    });
  await writeFile(
    join(runDirectory, 'metrics', 'correspondences.json'),
    correspondenceText
  );
  const databaseBytes = new Uint8Array([1, 2, 3]);
  const binaryFiles = [
    'cameras.bin',
    'frames.bin',
    'images.bin',
    'points3D.bin',
    'rigs.bin',
  ] as const;
  const binaryBytes = Object.fromEntries(
    binaryFiles.map((filename) => [filename, new TextEncoder().encode(filename)])
  );
  await writeFile(join(runDirectory, 'database', 'selected.db'), databaseBytes);
  await Promise.all(
    binaryFiles.map((filename) =>
      Promise.all([
        writeFile(
          join(runDirectory, 'models', 'triangulated', filename),
          binaryBytes[filename]!
        ),
        mkdir(join(runDirectory, 'models', 'adjusted'), { recursive: true }).then(
          () =>
            writeFile(
              join(runDirectory, 'models', 'adjusted', filename),
              binaryBytes[filename]!
            )
        ),
      ])
    )
  );
  const bindings = {
    inputSha256: '1'.repeat(64),
    matchingDatabase: {
      path: 'database/selected.db',
      sha256: sha256(databaseBytes),
    },
    triangulatedModel: {
      'cameras.txt': sha256(baseline.cameras),
      'images.txt': sha256(baseline.images),
      'points3D.txt': sha256(baseline.points),
    },
    triangulatedBinaryModel: Object.fromEntries(
      binaryFiles.map((filename) => [filename, sha256(binaryBytes[filename]!)])
    ),
    correspondencesSha256: sha256(correspondenceText),
  };
  const preBaText = JSON.stringify({
      schemaVersion: 1,
      status: 'pass',
      baParticipationEvaluated: false,
      bindings,
      policy: options.changedPolicy
        ? { ...acceptancePolicy, improvementTolerancePx: -1 }
        : acceptancePolicy,
    });
  await writeFile(join(runDirectory, 'metrics', 'pre-ba-support.json'), preBaText);
  const residualSelection = {
    method: 'pycolmap-config-num-residuals-v2',
    nativeApi: 'BundleAdjustmentConfig.num_residuals',
    configuredImageIds: imageIds,
    reconstructionImageIds: imageIds,
    linkedObservationCount: points.length * names.length,
    expectedScalarResidualCount: points.length * names.length * 2,
    nativeScalarResidualCount: points.length * names.length * 2,
    identityProof: options.missingNativeSelectionProof
      ? {
          status: 'unavailable',
          reason: 'native runtime exposes counts only',
        }
      : {
          status: 'verified',
          method: 'native-residual-identity-inventory-v1',
          pycolmapBinaryHashes: { native: '2'.repeat(64) },
        },
    observationIdentities: points.flatMap((_, pointIndex) =>
      imageIds.map((imageId) => ({
        imageId:
          options.wrongResidualIdentity && pointIndex === 14 && imageId === 44
            ? 999
            : imageId,
        point2DIndex: pointIndex,
        point3DId: pointIndex + 1,
      }))
    ),
  };
  const driverBytes = await readFile(
    fileURLToPath(new URL('../../scripts/three-anchor-ba.py', import.meta.url))
  );
  const resolvedConfigText = '{}';
  await writeFile(join(runDirectory, 'resolved-config.json'), resolvedConfigText);
  const inspectionText = JSON.stringify({
    schemaVersion: 1,
    solveCalled: false,
    scalarReprojectionResidualCount: points.length * names.length * 2,
    optimizationInputs: bindings,
    residualSelection,
    pycolmapBinaryHashes: { native: '2'.repeat(64) },
    effectiveConfig: 'three anchors',
    effectiveOptions: 'translation only',
  });
  await writeFile(
    join(runDirectory, 'evidence', 'ba-inspection.json'),
    inspectionText
  );
  const attemptText = JSON.stringify({ schemaVersion: 1, permanent: true });
  await writeFile(join(runDirectory, 'evidence', 'ba-attempt.json'), attemptText);
  const nativeStartText = JSON.stringify({ schemaVersion: 1, permanent: true });
  await writeFile(
    join(runDirectory, 'evidence', 'ba-native-start.json'),
    nativeStartText
  );
  await writeFile(
    join(runDirectory, 'evidence', 'ba-result.json'),
    JSON.stringify({
      schemaVersion: 1,
      status: 'pass',
      solveCalled: true,
      solutionUsable: true,
      inputSha256: '1'.repeat(64),
      preBaSha256: sha256(preBaText),
      inspectionSha256: sha256(inspectionText),
      attemptSha256: sha256(attemptText),
      nativeStartSha256: sha256(nativeStartText),
      driverSha256: sha256(driverBytes),
      resolvedConfigSha256: sha256(resolvedConfigText),
      scalarReprojectionResidualCount: points.length * names.length * 2,
      optimizationInputs: bindings,
      residualSelection,
      pycolmapBinaryHashes: { native: '2'.repeat(64) },
      effectiveConfig: 'three anchors',
      effectiveOptions: 'translation only',
      binaryHashes: Object.fromEntries(
        binaryFiles.map((filename) => [filename, sha256(binaryBytes[filename]!)])
      ),
      exportHashes: {
        'cameras.txt': sha256(candidate.cameras),
        'images.txt': sha256(candidate.images),
        'points3D.txt': sha256(candidate.points),
      },
      hardLocks: {
        passed: true,
        identityUnchanged: true,
        intrinsicsUnchanged: true,
        maxRotationQuaternionComponentDelta: 0,
        maxAnchorCentreDelta: 0,
        maxAnchorTranslationDelta: 0,
        maxAnchorDistanceDelta: 0,
      },
    })
  );
  const recorderImages = names.map((name, index) => ({
    imageId: imageIds[index]!,
    cameraId: 1,
    name,
    pose: {
      qvec: [1, 0, 0, 0] as const,
      tvec: [
        -baselineCentres[index]![0],
        -baselineCentres[index]![1],
        0,
      ] as const,
    },
    observations: [],
  }));
  const dataset = {
    model: {
      cameras: [
        {
          cameraId: 1,
          model: 'PINHOLE' as const,
          width: 640,
          height: 480,
          intrinsics: { fx: 500, fy: 500, cx: 320, cy: 240 },
        },
      ],
      images: recorderImages,
      points3D: [],
    },
    sourceArchive: {},
  } as unknown as RecorderDataset;
  const preflight: RefinerPreflight = {
    config: {
      inputZip: 'capture.zip',
      outputDirectory: runDirectory,
      colmap: {
        executable: 'colmap',
        version: '4.2.0',
        build: 'test',
        sha256: '0'.repeat(64),
      },
      python: {
        executable: 'python',
        sha256: '0'.repeat(64),
        pycolmapVersion: '4.2.0',
      },
      anchors: [names[0]!, names[1]!, names[2]!],
      loopPairs,
    },
    dataset,
    inputZipBytes: new Uint8Array(),
    inputSha256: '1'.repeat(64),
    sequentialPairs,
  };
  return {
    preflight,
    run: {
      runDirectory,
      resolvedConfigPath: join(runDirectory, 'resolved-config.json'),
    },
  };
}

function project(
  point: readonly [number, number, number],
  centre: readonly number[]
): readonly [number, number] {
  return [
    500 * ((point[0] - centre[0]!) / point[2]) + 320,
    500 * ((point[1] - centre[1]!) / point[2]) + 240,
  ];
}

async function readReport(runDirectory: string) {
  return JSON.parse(
    await readFile(join(runDirectory, 'metrics', 'post-ba-safety.json'), 'utf8')
  ) as unknown;
}

function sha256(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex');
}
