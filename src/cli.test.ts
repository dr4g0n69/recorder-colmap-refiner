import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { afterEach, describe, expect, it } from 'vitest';

import { runRefinerCli } from './cli.js';
import { parseRecorderColmapText } from './colmap/text-codec.js';
import type {
  NativeCommand,
  NativeCommandExecutor,
} from './refiner/native-command.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

describe('runRefinerCli', () => {
  it('rejects a configuration without exactly three anchors before creating a run', async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, 'run.json');
    await writeFile(
      configPath,
      JSON.stringify({
        inputZip: './capture.zip',
        outputDirectory: './runs',
        anchors: ['frame-000001.jpg', 'frame-000050.jpg'],
        loopPairs: [['frame-000001.jpg', 'frame-000091.jpg']],
      })
    );
    const messages: string[] = [];

    const exitCode = await runRefinerCli(
      ['refine', '--config', configPath],
      (message) => messages.push(message)
    );

    expect(exitCode).toBe(1);
    expect(messages).toEqual([
      'Configuration error: anchors must contain exactly three image names.',
    ]);
    await expect(readFile(join(directory, 'runs'))).rejects.toThrow();
  });

  it('rejects an anchor that is absent from the recorder model', async () => {
    const directory = await preparedDirectory();
    const configPath = await writeConfig(directory, {
      anchors: [
        'frame-000001.jpg',
        'frame-000002.jpg',
        'frame-000099.jpg',
      ],
      loopPairs: [['frame-000001.jpg', 'frame-000003.jpg']],
    });
    const messages: string[] = [];

    const exitCode = await runRefinerCli(
      ['refine', '--config', configPath],
      (message) => messages.push(message)
    );

    expect(exitCode).toBe(1);
    expect(messages).toEqual([
      'Configuration error: anchor image frame-000099.jpg is absent from the recorder model.',
    ]);
    await expect(readFile(join(directory, 'runs'))).rejects.toThrow();
  });

  it('rejects a loop-pair image that is absent from the recorder model', async () => {
    const directory = await preparedDirectory();
    const configPath = await writeConfig(directory, {
      anchors: [
        'frame-000001.jpg',
        'frame-000002.jpg',
        'frame-000003.jpg',
      ],
      loopPairs: [['frame-000001.jpg', 'frame-000099.jpg']],
    });
    const messages: string[] = [];

    const exitCode = await runRefinerCli(
      ['refine', '--config', configPath],
      (message) => messages.push(message)
    );

    expect(exitCode).toBe(1);
    expect(messages).toEqual([
      'Configuration error: loop-pair image frame-000099.jpg is absent from the recorder model.',
    ]);
    await expect(readFile(join(directory, 'runs'))).rejects.toThrow();
  });

  it('rejects an unexpected COLMAP executable before creating a run', async () => {
    const directory = await preparedDirectory();
    const configPath = await writeConfig(
      directory,
      validSelection,
      '0'.repeat(64)
    );
    const calls: NativeCommand[] = [];
    const messages: string[] = [];

    const exitCode = await runRefinerCli(
      ['refine', '--config', configPath],
      (message) => messages.push(message),
      async (command) => {
        calls.push(command);
        return successfulResult('');
      }
    );

    expect(exitCode).toBe(1);
    expect(calls).toEqual([]);
    expect(messages).toEqual([
      'Configuration error: COLMAP executable SHA-256 does not match the configured identity.',
    ]);
    await expect(readFile(join(directory, 'runs'))).rejects.toThrow();
  });

  it('stops before feature extraction when COLMAP help lacks the expected build', async () => {
    const directory = await preparedDirectory();
    const configPath = await writeConfig(directory, validSelection);
    const calls: NativeCommand[] = [];
    const messages: string[] = [];

    const exitCode = await runRefinerCli(
      ['refine', '--config', configPath],
      (message) => messages.push(message),
      async (command) => {
        calls.push(command);
        return successfulResult('COLMAP 4.2.0 unknown build');
      }
    );

    expect(exitCode).toBe(1);
    expect(calls.map((command) => command.stage)).toEqual(['colmap-identity']);
    expect(messages[0]).toMatch(/^Prepared run: /);
    expect(messages[1]).toBe(
      'Execution error: COLMAP help does not match configured version/build identity.'
    );
  });

  it('rejects a case-changed database image before freezing the matching checkpoint', async () => {
    const directory = await preparedDirectory();
    const configPath = await writeConfig(directory, validSelection);
    const messages: string[] = [];
    const calls: NativeCommand[] = [];

    const exitCode = await runRefinerCli(
      ['refine', '--config', configPath],
      (message) => messages.push(message),
      successfulColmapExecutor(calls, {
        imageNames: [
          'Frame-000001.jpg',
          'frame-000002.jpg',
          'frame-000003.jpg',
        ],
      })
    );

    expect(exitCode).toBe(1);
    expect(messages.at(-1)).toBe(
      'Execution error: database filenames must exactly match recorder filenames case-sensitively.'
    );
    const [run] = await readdir(join(directory, 'runs'));
    await expect(
      readFile(join(directory, 'runs', run!, 'database', 'exhaustive.db'))
    ).rejects.toThrow();
  });

  it('rejects changed database calibration before freezing the matching checkpoint', async () => {
    const directory = await preparedDirectory();
    const configPath = await writeConfig(directory, validSelection);
    const messages: string[] = [];

    const exitCode = await runRefinerCli(
      ['refine', '--config', configPath],
      (message) => messages.push(message),
      successfulColmapExecutor([], { cameraParams: [501, 500, 320, 240] })
    );

    expect(exitCode).toBe(1);
    expect(messages.at(-1)).toBe(
      'Execution error: database camera must exactly match recorder calibration.'
    );
    const [run] = await readdir(join(directory, 'runs'));
    await expect(
      readFile(join(directory, 'runs', run!, 'database', 'exhaustive.db'))
    ).rejects.toThrow();
  });

  it('rejects a successful matcher command that adds no correspondences', async () => {
    const directory = await preparedDirectory();
    const configPath = await writeConfig(directory, validSelection);
    const messages: string[] = [];

    const exitCode = await runRefinerCli(
      ['refine', '--config', configPath],
      (message) => messages.push(message),
      successfulColmapExecutor([], { addMatches: false })
    );

    expect(exitCode).toBe(1);
    expect(messages.at(-1)).toBe(
      'Execution error: exhaustive matcher added no verified correspondences.'
    );
  });

  it('rejects a fixed-pose triangulation result that changes a recorder pose', async () => {
    const directory = await preparedDirectory();
    const configPath = await writeConfig(directory, validSelection);
    const messages: string[] = [];

    const exitCode = await runRefinerCli(
      ['refine', '--config', configPath],
      (message) => messages.push(message),
      successfulColmapExecutor([], { returnedTranslationX: 2 })
    );

    expect(exitCode).toBe(1);
    expect(messages.at(-1)).toBe(
      'Execution error: triangulation changed pose for frame-000001.jpg.'
    );
  });

  it('stops before BA when a required loop pair lacks verified support', async () => {
    const directory = await preparedDirectory();
    const configPath = await writeConfig(directory, validSelection);
    const messages: string[] = [];

    const exitCode = await runRefinerCli(
      ['refine', '--config', configPath],
      (message) => messages.push(message),
      successfulColmapExecutor([], { omitLoopMatches: true })
    );

    expect(exitCode).toBe(1);
    expect(messages.at(-1)).toBe(
      'Execution error: pre-BA support is insufficient for frame-000001.jpg / frame-000003.jpg.'
    );
  });

  it('rejects an inspection report that claims the solver was called', async () => {
    const directory = await preparedDirectory();
    const configPath = await writeConfig(directory, validSelection);
    const messages: string[] = [];

    const exitCode = await runRefinerCli(
      ['refine', '--config', configPath],
      (message) => messages.push(message),
      successfulColmapExecutor([], { inspectionSolveCalled: true })
    );

    expect(exitCode).toBe(1);
    expect(messages.at(-1)).toBe(
      'Execution error: BA inspection must not call the solver.'
    );
  });

  it('permanently records a failed BA attempt without publishing adjusted output', async () => {
    const directory = await preparedDirectory();
    const configPath = await writeConfig(directory, validSelection);
    const messages: string[] = [];

    const exitCode = await runRefinerCli(
      ['refine', '--config', configPath],
      (message) => messages.push(message),
      successfulColmapExecutor([], { failBaSolve: true })
    );

    expect(exitCode).toBe(1);
    expect(messages.at(-1)).toBe(
      'Execution error: ba-solve failed with exit code 2.'
    );
    const [run] = await readdir(join(directory, 'runs'));
    expect(
      JSON.parse(
        await readFile(
          join(directory, 'runs', run!, 'evidence', 'ba-attempt.json'),
          'utf8'
        )
      )
    ).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        permanent: true,
        inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        inspectionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
    );
    await expect(
      stat(join(directory, 'runs', run!, 'models', 'adjusted'))
    ).rejects.toThrow();
    await expect(
      stat(join(directory, 'runs', run!, 'exports', 'adjusted'))
    ).rejects.toThrow();
  });

  it('rejects adjusted output that changes a fixed rotation despite a passing native report', async () => {
    const directory = await preparedDirectory();
    const configPath = await writeConfig(directory, validSelection);
    const messages: string[] = [];

    const exitCode = await runRefinerCli(
      ['refine', '--config', configPath],
      (message) => messages.push(message),
      successfulColmapExecutor([], { adjustedRotationChanged: true })
    );

    expect(exitCode).toBe(1);
    expect(messages.at(-1)).toBe(
      'Execution error: BA adjusted export changed rotation for frame-000002.jpg.'
    );
  });

  it('creates independent immutable records for repeated valid preflights', async () => {
    const directory = await preparedDirectory();
    const selection = validSelection;
    const configPath = await writeConfig(directory, selection);
    const messages: string[] = [];
    const calls: NativeCommand[] = [];
    const executor = successfulColmapExecutor(calls);

    expect(
      await runRefinerCli(
        ['refine', '--config', configPath],
        (message) => messages.push(message),
        executor
      )
    ).toBe(1);

    const runsDirectory = join(directory, 'runs');
    const [firstRun] = await readdir(runsDirectory);
    expect(firstRun).toBeDefined();
    const firstRecordPath = join(
      runsDirectory,
      firstRun!,
      'resolved-config.json'
    );
    const firstRecordBytes = await readFile(firstRecordPath);
    const firstRecord = JSON.parse(firstRecordBytes.toString()) as unknown;
    const inputBytes = await readFile(join(directory, 'capture.zip'));

    expect(firstRecord).toEqual({
      schemaVersion: 1,
      inputZip: {
        path: join(directory, 'capture.zip'),
        sha256: createHash('sha256').update(inputBytes).digest('hex'),
      },
      outputDirectory: runsDirectory,
      colmap: {
        executable: join(directory, 'colmap.exe'),
        version: '4.2.0',
        build: 'be5e291 (CUDA)',
        sha256: createHash('sha256')
          .update(await readFile(join(directory, 'colmap.exe')))
          .digest('hex'),
      },
      python: {
        executable: join(directory, 'python.exe'),
        sha256: createHash('sha256')
          .update(await readFile(join(directory, 'python.exe')))
          .digest('hex'),
        pycolmapVersion: '4.2.0',
      },
      anchors: selection.anchors,
      loopPairs: selection.loopPairs,
      sequentialPairs: [
        ['frame-000001.jpg', 'frame-000002.jpg'],
        ['frame-000002.jpg', 'frame-000003.jpg'],
      ],
      imageCount: 3,
    });
    expect(
      await readFile(join(runsDirectory, firstRun!, 'input', 'original.zip'))
    ).toEqual(inputBytes);
    expect(await readdir(join(runsDirectory, firstRun!, 'images'))).toEqual([
      'frame-000001.jpg',
      'frame-000002.jpg',
      'frame-000003.jpg',
    ]);
    expect(
      Array.from(
        await readFile(
          join(runsDirectory, firstRun!, 'images', 'frame-000001.jpg')
        )
      )
    ).toEqual([255, 216, 1, 255, 217]);

    const knownDirectory = join(runsDirectory, firstRun!, 'models', 'known');
    const knownModel = parseRecorderColmapText({
      cameras: await readFile(join(knownDirectory, 'cameras.txt')),
      images: await readFile(join(knownDirectory, 'images.txt')),
      points3D: await readFile(join(knownDirectory, 'points3D.txt')),
    });
    expect(knownModel.cameras).toHaveLength(1);
    expect(knownModel.cameras[0]!.cameraId).toBe(41);
    expect(knownModel.images.map((image) => image.name)).toEqual([
      'frame-000001.jpg',
      'frame-000002.jpg',
      'frame-000003.jpg',
    ]);
    expect(knownModel.images.map((image) => image.imageId)).toEqual([
      20, 5, 80,
    ]);
    expect(knownModel.images.map((image) => image.cameraId)).toEqual([
      41, 41, 41,
    ]);
    expect(
      knownModel.images.every((image) => image.observations.length === 0)
    ).toBe(true);
    expect(knownModel.points3D).toEqual([]);
    expect(
      JSON.parse(
        await readFile(join(runsDirectory, firstRun!, 'poses.json'), 'utf8')
      )
    ).toEqual({
      schemaVersion: 1,
      images: [
        {
          originalImageId: 1,
          imageName: 'frame-000001.jpg',
          cameraId: 1,
          qvec: [1, 0, 0, 0],
          tvec: [1, 0, 0],
        },
        {
          originalImageId: 2,
          imageName: 'frame-000002.jpg',
          cameraId: 1,
          qvec: [1, 0, 0, 0],
          tvec: [0, 0, 0],
        },
        {
          originalImageId: 3,
          imageName: 'frame-000003.jpg',
          cameraId: 1,
          qvec: [1, 0, 0, 0],
          tvec: [-1, 0, 0],
        },
      ],
    });
    for (const relativePath of [
      'database',
      'models/triangulated',
      'models/adjusted',
      'exports/triangulated',
      'exports/adjusted',
      'output',
      'logs',
      'metrics',
      'evidence',
    ]) {
      expect(
        (await stat(join(runsDirectory, firstRun!, relativePath))).isDirectory()
      ).toBe(true);
    }
    const firstDatabaseDirectory = join(
      runsDirectory,
      firstRun!,
      'database'
    );
    expect(
      await readFile(join(firstDatabaseDirectory, 'exhaustive.db'))
    ).not.toEqual(
      await readFile(join(firstDatabaseDirectory, 'features.db'))
    );
    expect(
      JSON.parse(
        await readFile(
          join(
            runsDirectory,
            firstRun!,
            'evidence',
            'feature-extraction.json'
          ),
          'utf8'
        )
      )
    ).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        featuresDatabase: expect.objectContaining({
          path: 'database/features.db',
        }),
      })
    );
    expect(
      JSON.parse(
        await readFile(
          join(runsDirectory, firstRun!, 'evidence', 'ba-result.json'),
          'utf8'
        )
      )
    ).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        status: 'pass',
        solveCalled: true,
        solutionUsable: true,
        hardLocks: expect.objectContaining({
          passed: true,
          identityUnchanged: true,
          intrinsicsUnchanged: true,
        }),
      })
    );
    expect(
      JSON.parse(
        await readFile(
          join(runsDirectory, firstRun!, 'metrics', 'pre-ba-support.json'),
          'utf8'
        )
      )
    ).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        status: 'pass',
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
        connectedComponents: [
          [
            'frame-000001.jpg',
            'frame-000002.jpg',
            'frame-000003.jpg',
          ],
        ],
        pairs: expect.arrayContaining([
          expect.objectContaining({
            images: ['frame-000001.jpg', 'frame-000003.jpg'],
            roles: ['loop'],
            rawMatches: 20,
            verifiedMatches: 15,
            usableTrackCount: 15,
            usableObservationCount: 30,
            status: 'pass',
          }),
        ]),
      })
    );
    expect(
      JSON.parse(
        await readFile(
          join(runsDirectory, firstRun!, 'metrics', 'post-ba-safety.json'),
          'utf8'
        )
      )
    ).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        verdict: 'Rejected',
        finalAcceptance: false,
        nextRequiredGate: null,
        rejections: expect.arrayContaining([
          'Aggregate epipolar error did not improve.',
        ]),
      })
    );
    expect(
      await readFile(
        join(runsDirectory, firstRun!, 'metrics', 'loop-support.md'),
        'utf8'
      )
    ).toContain('| frame-000001.jpg / frame-000003.jpg | loop | 20 | 15 | 15 |');
    expect(
      JSON.parse(
        await readFile(
          join(runsDirectory, firstRun!, 'evidence', 'ba-inspection.json'),
          'utf8'
        )
      )
    ).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        solveCalled: false,
        pycolmapVersion: '4.2.0',
        registeredImageCount: 3,
        fixedFullPoseFrameCount: 3,
        fixedRotationFrameCount: 3,
        variableTranslationFrameCount: 0,
        fixedIntrinsicsCameraCount: 1,
        linkedObservationCount: 45,
        scalarReprojectionResidualCount: 90,
        anchors: [
          expect.objectContaining({ filename: 'frame-000001.jpg' }),
          expect.objectContaining({ filename: 'frame-000002.jpg' }),
          expect.objectContaining({ filename: 'frame-000003.jpg' }),
        ],
      })
    );
    expect(
      JSON.parse(
        await readFile(
          join(runsDirectory, firstRun!, 'evidence', 'database-handoff.json'),
          'utf8'
        )
      )
    ).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        images: [
          {
            originalImageId: 1,
            imageName: 'frame-000001.jpg',
            databaseImageId: 20,
            originalCameraId: 1,
            databaseCameraId: 41,
          },
          {
            originalImageId: 2,
            imageName: 'frame-000002.jpg',
            databaseImageId: 5,
            originalCameraId: 1,
            databaseCameraId: 41,
          },
          {
            originalImageId: 3,
            imageName: 'frame-000003.jpg',
            databaseImageId: 80,
            originalCameraId: 1,
            databaseCameraId: 41,
          },
        ],
      })
    );
    expect(
      JSON.parse(
        await readFile(
          join(runsDirectory, firstRun!, 'evidence', 'exhaustive-matching.json'),
          'utf8'
        )
      )
    ).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        rawMatches: {
          before: { pairs: 0, correspondences: 0 },
          after: { pairs: 3, correspondences: 60 },
        },
        verifiedMatches: {
          before: { pairs: 0, correspondences: 0 },
          after: { pairs: 3, correspondences: 45 },
        },
      })
    );
    expect(
      JSON.parse(
        await readFile(
          join(runsDirectory, firstRun!, 'evidence', 'triangulation.json'),
          'utf8'
        )
      )
    ).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        imageCount: 3,
        observationCount: 45,
        pointCount: 15,
      })
    );
    expect(
      calls.map((command) => [command.stage, command.args[0]])
    ).toEqual([
      ['colmap-identity', '-h'],
      ['feature-extractor', 'feature_extractor'],
      ['exhaustive-matcher', 'exhaustive_matcher'],
      ['point-triangulator', 'point_triangulator'],
      ['model-converter', 'model_converter'],
      ['ba-inspect', expect.stringMatching(/three-anchor-ba\.py$/)],
      ['ba-solve', expect.stringMatching(/three-anchor-ba\.py$/)],
    ]);

    expect(
      await runRefinerCli(
        ['refine', '--config', configPath],
        (message) => messages.push(message),
        executor
      )
    ).toBe(1);
    expect(await readdir(runsDirectory)).toHaveLength(2);
    expect(await readFile(firstRecordPath)).toEqual(firstRecordBytes);
    expect(messages[0]).toMatch(/^Prepared run: /);
    expect(messages[1]).toBe('Feature extraction: complete');
    expect(messages[2]).toBe('Feature database identity: verified');
    expect(messages[3]).toBe('Exhaustive matching: complete');
    expect(messages[4]).toBe('Fixed-pose triangulation: complete');
    expect(messages[5]).toBe('Pre-BA support: verified');
    expect(messages[6]).toBe('BA configuration: inspected without solving');
    expect(messages[7]).toBe('Three-anchor bundle adjustment: complete');
    expect(messages[8]).toBe('Post-BA geometry: Rejected');
    expect(messages[9]).toBe('Pipeline execution is not implemented yet.');
    expect(messages[10]).toMatch(/^Prepared run: /);
    expect(messages[11]).toBe('Feature extraction: complete');
    expect(messages[12]).toBe('Feature database identity: verified');
    expect(messages[13]).toBe('Exhaustive matching: complete');
    expect(messages[14]).toBe('Fixed-pose triangulation: complete');
    expect(messages[15]).toBe('Pre-BA support: verified');
    expect(messages[16]).toBe('BA configuration: inspected without solving');
    expect(messages[17]).toBe('Three-anchor bundle adjustment: complete');
    expect(messages[18]).toBe('Post-BA geometry: Rejected');
    expect(messages[19]).toBe('Pipeline execution is not implemented yet.');
    expect(messages).toHaveLength(20);
  });
});

const validSelection = {
  anchors: [
    'frame-000001.jpg',
    'frame-000002.jpg',
    'frame-000003.jpg',
  ],
  loopPairs: [['frame-000001.jpg', 'frame-000003.jpg']] as const,
} as const;

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'recorder-colmap-refiner-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function preparedDirectory(): Promise<string> {
  const directory = await temporaryDirectory();
  await writeFile(join(directory, 'capture.zip'), await recorderZip());
  await writeFile(join(directory, 'colmap.exe'), 'fake-colmap');
  await writeFile(join(directory, 'python.exe'), 'fake-python');
  return directory;
}

async function writeConfig(
  directory: string,
  selection: {
    anchors: readonly string[];
    loopPairs: readonly (readonly [string, string])[];
  },
  colmapSha256?: string
): Promise<string> {
  const path = join(directory, 'run.json');
  const executable = join(directory, 'colmap.exe');
  await writeFile(
    path,
    JSON.stringify({
      inputZip: './capture.zip',
      outputDirectory: './runs',
      colmap: {
        executable: './colmap.exe',
        version: '4.2.0',
        build: 'be5e291 (CUDA)',
        sha256:
          colmapSha256 ??
          createHash('sha256')
            .update(await readFile(executable))
            .digest('hex'),
      },
      python: {
        executable: './python.exe',
        sha256: createHash('sha256')
          .update(await readFile(join(directory, 'python.exe')))
          .digest('hex'),
        pycolmapVersion: '4.2.0',
      },
      ...selection,
    })
  );
  return path;
}

function successfulColmapExecutor(
  calls: NativeCommand[],
  options: {
    readonly imageNames?: readonly string[];
    readonly cameraParams?: readonly [number, number, number, number];
    readonly addMatches?: boolean;
    readonly returnedTranslationX?: number;
    readonly omitLoopMatches?: boolean;
    readonly inspectionSolveCalled?: boolean;
    readonly failBaSolve?: boolean;
    readonly adjustedRotationChanged?: boolean;
  } = {}
): NativeCommandExecutor {
  const imageNames = options.imageNames ?? [
    'frame-000001.jpg',
    'frame-000002.jpg',
    'frame-000003.jpg',
  ];
  const cameraParams = options.cameraParams ?? [500, 500, 320, 240];
  return async (command) => {
    calls.push(command);
    if (command.stage === 'feature-extractor') {
      writeFeaturesDatabase(command.cwd, imageNames, cameraParams);
    }
    if (command.stage === 'exhaustive-matcher' && options.addMatches !== false) {
      writeMatchRows(command.cwd, options.omitLoopMatches === true);
    }
    if (command.stage === 'model-converter') {
      await writeTriangulatedText(
        command.cwd,
        options.returnedTranslationX ?? 1
      );
    }
    if (command.stage === 'ba-inspect') {
      await writeBaInspection(
        command,
        options.inspectionSolveCalled === true
      );
    }
    if (command.stage === 'ba-solve' && options.failBaSolve === true) {
      return { exitCode: 2, signal: null, stdout: '', stderr: 'solve failed' };
    }
    if (command.stage === 'ba-solve') {
      await writeBaResult(command, options.adjustedRotationChanged === true);
    }
    return successfulResult('COLMAP 4.2.0 be5e291 (CUDA)');
  };
}

async function writeBaResult(
  command: NativeCommand,
  adjustedRotationChanged: boolean
): Promise<void> {
  const argument = (name: string) =>
    command.args[command.args.indexOf(name) + 1]!;
  const modelDirectory = join(command.cwd, 'models', 'adjusted');
  const exportDirectory = join(command.cwd, 'exports', 'adjusted');
  await Promise.all([
    mkdir(modelDirectory),
    mkdir(exportDirectory),
  ]);
  const binaryFilenames = [
    'cameras.bin',
    'frames.bin',
    'images.bin',
    'points3D.bin',
    'rigs.bin',
  ];
  const textFilenames = ['cameras.txt', 'images.txt', 'points3D.txt'];
  await Promise.all([
    ...binaryFilenames.map((filename) =>
      writeFile(join(modelDirectory, filename), `fake-${filename}`)
    ),
    ...textFilenames.map(async (filename) => {
      const baseline = await readFile(
        join(command.cwd, 'exports', 'triangulated', filename)
      );
      const output =
        adjustedRotationChanged && filename === 'images.txt'
          ? baseline
              .toString()
              .replace(
                '5 1 0 0 0 0 0 0 41 frame-000002.jpg',
                '5 0.7071067811865476 0 0.7071067811865476 0 0 0 0 41 frame-000002.jpg'
              )
          : baseline;
      await writeFile(join(exportDirectory, filename), output);
    }),
  ]);
  const hashes = async (directory: string, filenames: readonly string[]) =>
    Object.fromEntries(
      await Promise.all(
        filenames.map(async (filename) => [
          filename,
          createHash('sha256')
            .update(await readFile(join(directory, filename)))
            .digest('hex'),
        ])
      )
    );
  const inspection = JSON.parse(
    await readFile(join(command.cwd, 'evidence', 'ba-inspection.json'), 'utf8')
  ) as Record<string, unknown>;
  await writeFile(
    argument('--report'),
    `${JSON.stringify({
      schemaVersion: 1,
      status: 'pass',
      solveCalled: true,
      solutionUsable: true,
      inputSha256: argument('--input-sha256'),
      preBaSha256: argument('--pre-ba-sha256'),
      inspectionSha256: argument('--inspection-sha256'),
      attemptSha256: argument('--attempt-sha256'),
      driverSha256: createHash('sha256')
        .update(await readFile(command.args[0]!))
        .digest('hex'),
      resolvedConfigSha256: argument('--resolved-config-sha256'),
      pycolmapBinaryHashes: inspection.pycolmapBinaryHashes,
      effectiveConfig: inspection.effectiveConfig,
      effectiveOptions: inspection.effectiveOptions,
      scalarReprojectionResidualCount:
        inspection.scalarReprojectionResidualCount,
      hardLocks: {
        passed: true,
        identityUnchanged: true,
        intrinsicsUnchanged: true,
        maxRotationQuaternionComponentDelta: 0,
        maxAnchorCentreDelta: 0,
        maxAnchorTranslationDelta: 0,
        maxAnchorDistanceDelta: 0,
      },
      binaryHashes: await hashes(modelDirectory, binaryFilenames),
      exportHashes: await hashes(exportDirectory, textFilenames),
    }, null, 2)}\n`
  );
}

async function writeBaInspection(
  command: NativeCommand,
  solveCalled: boolean
): Promise<void> {
  const argument = (name: string) =>
    command.args[command.args.indexOf(name) + 1]!;
  await writeFile(
    join(command.cwd, 'evidence', 'ba-inspection.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      solveCalled,
      inputSha256: argument('--input-sha256'),
      preBaSupportSha256: argument('--pre-ba-sha256'),
      driverSha256: createHash('sha256')
        .update(await readFile(command.args[0]!))
        .digest('hex'),
      pythonVersion: '3.13.7',
      pythonExecutable: command.executable,
      pycolmapVersion: argument('--expected-pycolmap-version'),
      pycolmapModule: 'fake/pycolmap/__init__.py',
      pycolmapBinaryHashes: { 'fake/_core.pyd': '0'.repeat(64) },
      registeredImageCount: 3,
      fixedFullPoseFrameCount: 3,
      fixedRotationFrameCount: 3,
      variableTranslationFrameCount: 0,
      fixedIntrinsicsCameraCount: 1,
      linkedObservationCount: 45,
      scalarReprojectionResidualCount: 90,
      anchors: [
        { filename: 'frame-000001.jpg', imageId: 20, frameId: 1 },
        { filename: 'frame-000002.jpg', imageId: 5, frameId: 2 },
        { filename: 'frame-000003.jpg', imageId: 80, frameId: 3 },
      ],
      effectiveConfig: 'three fixed full poses',
      effectiveOptions: 'fixed rotations and intrinsics',
    }, null, 2)}\n`
  );
}

async function writeTriangulatedText(
  runDirectory: string,
  returnedTranslationX: number
): Promise<void> {
  const directory = join(runDirectory, 'exports', 'triangulated');
  await writeFile(
    join(directory, 'cameras.txt'),
    '41 PINHOLE 640 480 500 500 320 240\n'
  );
  await writeFile(
    join(directory, 'images.txt'),
    [
      `20 1 0 0 0 ${returnedTranslationX} 0 0 41 frame-000001.jpg`,
      observationsFor(20),
      '5 1 0 0 0 0 0 0 41 frame-000002.jpg',
      observationsFor(5),
      '80 1 0 0 0 -1 0 0 41 frame-000003.jpg',
      observationsFor(80),
      '',
    ].join('\n')
  );
  await writeFile(
    join(directory, 'points3D.txt'),
    `${Array.from({ length: 15 }, (_, index) =>
      `${index + 1} ${pointFor(index).join(' ')} 255 0 0 0.1 20 ${index} 5 ${index} 80 ${index}`
    ).join('\n')}\n`
  );
}

function observationsFor(imageId: 20 | 5 | 80): string {
  const translation = imageId === 20 ? 1 : imageId === 80 ? -1 : 0;
  return Array.from({ length: 15 }, (_, index) => {
    const [x, y, z] = pointFor(index);
    return `${500 * ((x + translation) / z) + 320} ${500 * (y / z) + 240} ${index + 1}`;
  }).join(' ');
}

function pointFor(index: number): readonly [number, number, number] {
  return [((index % 5) - 2) * 1.5, (Math.floor(index / 5) - 1) * 1.5, 10];
}

function writeFeaturesDatabase(
  runDirectory: string,
  imageNames: readonly string[],
  cameraParams: readonly [number, number, number, number]
): void {
  const database = new DatabaseSync(
    join(runDirectory, 'database', 'features.db')
  );
  try {
    database.exec(
      'CREATE TABLE cameras (camera_id INTEGER, model INTEGER, width INTEGER, height INTEGER, params BLOB, prior_focal_length INTEGER); CREATE TABLE images (image_id INTEGER, name TEXT, camera_id INTEGER); CREATE TABLE keypoints (image_id INTEGER, rows INTEGER, cols INTEGER, data BLOB); CREATE TABLE matches (pair_id INTEGER, rows INTEGER, cols INTEGER, data BLOB); CREATE TABLE two_view_geometries (pair_id INTEGER, rows INTEGER, cols INTEGER, data BLOB)'
    );
    const params = Buffer.alloc(32);
    cameraParams.forEach((value, index) =>
      params.writeDoubleLE(value, index * 8)
    );
    database
      .prepare('INSERT INTO cameras VALUES (41, 1, 640, 480, ?, 1)')
      .run(params);
    const ids = [20, 5, 80];
    imageNames.forEach((name, index) =>
      database
        .prepare('INSERT INTO images VALUES (?, ?, 41)')
        .run(ids[index]!, name)
    );
    ids.forEach((imageId) => {
      const keypoints = Buffer.alloc(15 * 2 * 4);
      for (let index = 0; index < 15; index++) {
        const [x, y, z] = pointFor(index);
        const translation = imageId === 20 ? 1 : imageId === 80 ? -1 : 0;
        keypoints.writeFloatLE(
          500 * ((x + translation) / z) + 320,
          index * 8
        );
        keypoints.writeFloatLE(500 * (y / z) + 240, index * 8 + 4);
      }
      database
        .prepare('INSERT INTO keypoints VALUES (?, 15, 2, ?)')
        .run(imageId, keypoints);
    });
  } finally {
    database.close();
  }
}

function writeMatchRows(runDirectory: string, omitLoopMatches: boolean): void {
  const database = new DatabaseSync(
    join(runDirectory, 'database', 'exhaustive.db')
  );
  try {
    for (const [first, second] of [
      [5, 20],
      [5, 80],
      ...(omitLoopMatches ? [] : [[20, 80]]),
    ]) {
      const pairId = BigInt(first!) * 2_147_483_647n + BigInt(second!);
      const raw = matchBlob(20);
      const verified = matchBlob(15);
      database
        .prepare('INSERT INTO matches VALUES (?, 20, 2, ?)')
        .run(pairId, raw);
      database
        .prepare('INSERT INTO two_view_geometries VALUES (?, 15, 2, ?)')
        .run(pairId, verified);
    }
  } finally {
    database.close();
  }
}

function matchBlob(rows: number): Buffer {
  const bytes = Buffer.alloc(rows * 2 * 4);
  for (let index = 0; index < rows; index++) {
    bytes.writeUInt32LE(index % 15, index * 8);
    bytes.writeUInt32LE(index % 15, index * 8 + 4);
  }
  return bytes;
}

function successfulResult(stdout: string) {
  return { exitCode: 0, signal: null, stdout, stderr: '' } as const;
}

async function recorderZip(): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  const encoder = new TextEncoder();
  const add = (path: string, bytes: Uint8Array) =>
    writer.add(path, new Uint8ArrayReader(bytes));

  await add(
    'sparse/0/cameras.txt',
    encoder.encode('1 PINHOLE 640 480 500 500 320 240\n')
  );
  await add(
    'sparse/0/images.txt',
    encoder.encode(
      [
        '1 1 0 0 0 1 0 0 1 frame-000001.jpg',
        '',
        '2 1 0 0 0 0 0 0 1 frame-000002.jpg',
        '',
        '3 1 0 0 0 -1 0 0 1 frame-000003.jpg',
        '',
      ].join('\n')
    )
  );
  await add(
    'sparse/0/points3D.txt',
    encoder.encode('7 0 0 1 1 2 3 0.5\n')
  );
  for (const [index, name] of [
    'frame-000001.jpg',
    'frame-000002.jpg',
    'frame-000003.jpg',
  ].entries()) {
    await add(
      `images/${name}`,
      new Uint8Array([255, 216, index + 1, 255, 217])
    );
  }
  await add(
    'images/unreferenced.jpg',
    new Uint8Array([255, 216, 99, 255, 217])
  );
  return writer.close();
}
