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
    expect(knownModel.images.map((image) => image.name)).toEqual([
      'frame-000001.jpg',
      'frame-000002.jpg',
      'frame-000003.jpg',
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
    await expect(
      readFile(join(firstDatabaseDirectory, 'exhaustive.db'))
    ).rejects.toThrow();
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
      calls.map((command) => [command.stage, command.args[0]])
    ).toEqual([
      ['colmap-identity', '-h'],
      ['feature-extractor', 'feature_extractor'],
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
    expect(messages).toHaveLength(6);
    expect(messages[0]).toMatch(/^Prepared run: /);
    expect(messages[1]).toBe('Feature extraction: complete');
    expect(messages[2]).toBe('Pipeline execution is not implemented yet.');
    expect(messages[3]).toMatch(/^Prepared run: /);
    expect(messages[4]).toBe('Feature extraction: complete');
    expect(messages[5]).toBe('Pipeline execution is not implemented yet.');
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
  calls: NativeCommand[]
): NativeCommandExecutor {
  return async (command) => {
    calls.push(command);
    if (command.stage === 'feature-extractor') {
      await writeFile(join(command.cwd, 'database', 'features.db'), 'features');
    }
    return successfulResult('COLMAP 4.2.0 be5e291 (CUDA)');
  };
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
