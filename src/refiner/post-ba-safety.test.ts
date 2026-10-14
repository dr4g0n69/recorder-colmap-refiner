import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RecorderDataset } from '../colmap/index.js';
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
    const fixture = await safetyFixture({ matchCount: 5 });

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
});

async function safetyFixture(
  options: {
    readonly damagedPoint?: boolean;
    readonly matchCount?: number;
  } = {}
) {
  const runDirectory = await mkdtemp(join(tmpdir(), 'post-ba-safety-'));
  temporaryDirectories.push(runDirectory);
  await Promise.all(
    ['metrics', 'evidence', 'exports/triangulated', 'exports/adjusted'].map(
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
  const candidateCentres = [
    ...baselineCentres.slice(0, 3),
    [0.6, 0.03, 0] as const,
  ];
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
    damagePoint: boolean
  ) => ({
    cameras: '1 PINHOLE 640 480 500 500 320 240\n',
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
  const candidate = modelText(candidateCentres, options.damagedPoint === true);
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
  await writeFile(
    join(runDirectory, 'metrics', 'correspondences.json'),
    JSON.stringify({
      schemaVersion: 1,
      pairs: required.map((pair, pairIndex) => ({
        images: pair,
        roles: [pairIndex < sequentialPairs.length ? 'sequential' : 'loop'],
        matches: points.slice(0, matchCount).map((_, pointIndex) => ({
          keypointIndices: [pointIndex, pointIndex],
          xy: pair.map((name) => observed[names.indexOf(name)]![pointIndex]!),
        })),
      })),
    })
  );
  await writeFile(
    join(runDirectory, 'metrics', 'pre-ba-support.json'),
    JSON.stringify({
      schemaVersion: 1,
      status: 'pass',
      baParticipationEvaluated: false,
      policy: {
        minVerifiedMatches: 15,
        minUsableTracks: 10,
        minUsableObservations: 20,
        minParallaxDegrees: 1.5,
        depthEpsilon: 0.000001,
        coverageGridRows: 10,
        coverageGridColumns: 10,
        minCoverageEachImage: 0.05,
      },
    })
  );
  await writeFile(
    join(runDirectory, 'evidence', 'ba-result.json'),
    JSON.stringify({
      schemaVersion: 1,
      status: 'pass',
      solveCalled: true,
      solutionUsable: true,
      scalarReprojectionResidualCount: points.length * names.length * 2,
      hardLocks: { passed: true },
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
