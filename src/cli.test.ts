import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { afterEach, describe, expect, it } from 'vitest';

import { runRefinerCli } from './cli.js';

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
  await add('sparse/0/points3D.txt', new Uint8Array());
  for (const name of [
    'frame-000001.jpg',
    'frame-000002.jpg',
    'frame-000003.jpg',
  ]) {
    await add(`images/${name}`, new Uint8Array([255, 216, 255, 217]));
  }
  return writer.close();
}
