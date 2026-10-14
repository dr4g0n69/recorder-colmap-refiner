import { createHash } from 'node:crypto';
import {
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
      successfulColmapExecutor([], { returnedTranslationX: 1 })
    );

    expect(exitCode).toBe(1);
    expect(messages.at(-1)).toBe(
      'Execution error: triangulation changed pose for frame-000001.jpg.'
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
          tvec: [0, 0, 0],
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
          tvec: [0, 0, 0],
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
          after: { pairs: 1, correspondences: 12 },
        },
        verifiedMatches: {
          before: { pairs: 0, correspondences: 0 },
          after: { pairs: 1, correspondences: 8 },
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
        observationCount: 6,
        pointCount: 2,
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
    expect(messages).toHaveLength(12);
    expect(messages[0]).toMatch(/^Prepared run: /);
    expect(messages[1]).toBe('Feature extraction: complete');
    expect(messages[2]).toBe('Feature database identity: verified');
    expect(messages[3]).toBe('Exhaustive matching: complete');
    expect(messages[4]).toBe('Fixed-pose triangulation: complete');
    expect(messages[5]).toBe('Pipeline execution is not implemented yet.');
    expect(messages[6]).toMatch(/^Prepared run: /);
    expect(messages[7]).toBe('Feature extraction: complete');
    expect(messages[8]).toBe('Feature database identity: verified');
    expect(messages[9]).toBe('Exhaustive matching: complete');
    expect(messages[10]).toBe('Fixed-pose triangulation: complete');
    expect(messages[11]).toBe('Pipeline execution is not implemented yet.');
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
      writeMatchRows(command.cwd);
    }
    if (command.stage === 'model-converter') {
      await writeTriangulatedText(
        command.cwd,
        options.returnedTranslationX ?? 0
      );
    }
    return successfulResult('COLMAP 4.2.0 be5e291 (CUDA)');
  };
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
      '10 10 1 20 20 2',
      '5 1 0 0 0 0 0 0 41 frame-000002.jpg',
      '11 10 1 21 20 2',
      '80 1 0 0 0 0 0 0 41 frame-000003.jpg',
      '12 10 1 22 20 2',
      '',
    ].join('\n')
  );
  await writeFile(
    join(directory, 'points3D.txt'),
    [
      '1 0 0 1 255 0 0 0.1 20 0 5 0 80 0',
      '2 1 0 1 0 255 0 0.2 20 1 5 1 80 1',
      '',
    ].join('\n')
  );
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
      'CREATE TABLE cameras (camera_id INTEGER, model INTEGER, width INTEGER, height INTEGER, params BLOB, prior_focal_length INTEGER); CREATE TABLE images (image_id INTEGER, name TEXT, camera_id INTEGER); CREATE TABLE matches (pair_id INTEGER, rows INTEGER, cols INTEGER, data BLOB); CREATE TABLE two_view_geometries (pair_id INTEGER, rows INTEGER, cols INTEGER, data BLOB)'
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
  } finally {
    database.close();
  }
}

function writeMatchRows(runDirectory: string): void {
  const database = new DatabaseSync(
    join(runDirectory, 'database', 'exhaustive.db')
  );
  try {
    database
      .prepare('INSERT INTO matches VALUES (1, 12, 2, ?)')
      .run(Buffer.alloc(12 * 2 * 4));
    database
      .prepare('INSERT INTO two_view_geometries VALUES (1, 8, 2, ?)')
      .run(Buffer.alloc(8 * 2 * 4));
  } finally {
    database.close();
  }
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
        '1 1 0 0 0 0 0 0 1 frame-000001.jpg',
        '',
        '2 1 0 0 0 0 0 0 1 frame-000002.jpg',
        '',
        '3 1 0 0 0 0 0 0 1 frame-000003.jpg',
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
