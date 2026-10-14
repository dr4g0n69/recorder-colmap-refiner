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

  it('creates independent immutable records for repeated valid preflights', async () => {
    const directory = await preparedDirectory();
    const selection = {
      anchors: [
        'frame-000001.jpg',
        'frame-000002.jpg',
        'frame-000003.jpg',
      ],
      loopPairs: [['frame-000001.jpg', 'frame-000003.jpg']] as const,
    } as const;
    const configPath = await writeConfig(directory, selection);
    const messages: string[] = [];

    expect(
      await runRefinerCli(['refine', '--config', configPath], (message) =>
        messages.push(message)
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

    expect(
      await runRefinerCli(['refine', '--config', configPath], (message) =>
        messages.push(message)
      )
    ).toBe(1);
    expect(await readdir(runsDirectory)).toHaveLength(2);
    expect(await readFile(firstRecordPath)).toEqual(firstRecordBytes);
    expect(messages).toHaveLength(4);
    expect(messages[0]).toMatch(/^Prepared run: /);
    expect(messages[1]).toBe('Pipeline execution is not implemented yet.');
    expect(messages[2]).toMatch(/^Prepared run: /);
    expect(messages[3]).toBe('Pipeline execution is not implemented yet.');
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'recorder-colmap-refiner-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function preparedDirectory(): Promise<string> {
  const directory = await temporaryDirectory();
  await writeFile(join(directory, 'capture.zip'), await recorderZip());
  return directory;
}

async function writeConfig(
  directory: string,
  selection: {
    anchors: readonly string[];
    loopPairs: readonly (readonly [string, string])[];
  }
): Promise<string> {
  const path = join(directory, 'run.json');
  await writeFile(
    path,
    JSON.stringify({
      inputZip: './capture.zip',
      outputDirectory: './runs',
      ...selection,
    })
  );
  return path;
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
