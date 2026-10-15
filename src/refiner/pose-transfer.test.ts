import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
} from '@zip.js/zip.js';
import { afterEach, describe, expect, it } from 'vitest';

import { readRecorderZip } from '../colmap/index.js';
import { acceptancePolicy } from './acceptance-policy.js';
import { transferAcceptedCandidate } from './pose-transfer.js';
import type { RefinerPreflight } from './preflight.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe('transferAcceptedCandidate', () => {
  it('does not publish a ZIP unless the retained geometry verdict passes', async () => {
    const runDirectory = await mkdtemp(join(tmpdir(), 'pose-transfer-'));
    temporaryDirectories.push(runDirectory);
    await mkdir(join(runDirectory, 'metrics'), { recursive: true });
    await writeFile(
      join(runDirectory, 'metrics', 'post-ba-safety.json'),
      JSON.stringify({ schemaVersion: 1, verdict: 'Rejected' })
    );

    await expect(
      transferAcceptedCandidate({} as never, {
        runDirectory,
        resolvedConfigPath: join(runDirectory, 'resolved-config.json'),
      })
    ).rejects.toThrow('Transfer requires a passing post-BA geometry verdict.');
  });

  it('publishes a separate verified pose-only ZIP and preserves opaque entries', async () => {
    const fixture = await transferFixture();

    const result = await transferAcceptedCandidate(
      fixture.preflight,
      fixture.run
    );

    expect(result.outputPath).toBe(
      join(fixture.run.runDirectory, 'output', 'candidate.zip')
    );
    const output = await readFile(result.outputPath);
    const reopened = await readRecorderZip(output);
    expect(reopened.model.images.map((image) => image.pose.tvec)).toEqual([
      [0.5, 0, 0],
      [0, 0, 0],
      [-0.5, 0, 0],
    ]);
    expect(
      reopened.model.images.every((image) => image.observations.length === 0)
    ).toBe(true);
    expect(reopened.model.points3D[0]!.xyz).toEqual([0, 0, 1]);
    expect(output).not.toEqual(fixture.inputBytes);
    const retained = await zipFiles(output);
    expect(retained.get('images/unreferenced.jpg')).toEqual(
      new Uint8Array([9, 8, 7])
    );
    expect(new TextDecoder().decode(retained.get('actions/events.json')!)).toBe(
      '{"kept":true}'
    );
    expect(new TextDecoder().decode(retained.get('session.json')!)).toBe(
      '{"session":"kept"}'
    );
    expect(retained.get('future/unknown.bin')).toEqual(
      new Uint8Array([6, 5, 4])
    );
    expect(
      JSON.parse(
        await readFile(
          join(fixture.run.runDirectory, 'output', 'transfer.json'),
          'utf8'
        )
      )
    ).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        status: 'pass',
        finalAcceptanceEvaluated: false,
        candidateSha256: sha256(output),
        verification: expect.objectContaining({
          poseOnlyMutation: true,
          reopenedSemanticCandidate: true,
          untouchedArchiveEntries: true,
        }),
      })
    );
    expect(
      JSON.parse(
        await readFile(
          join(fixture.run.runDirectory, 'output', 'run-result.json'),
          'utf8'
        )
      )
    ).toEqual(
      expect.objectContaining({
        stage: 'zip-transfer',
        outcome: 'Delivered',
        candidateSha256: sha256(output),
      })
    );
    await expect(
      stat(join(fixture.run.runDirectory, 'run-result.json'))
    ).rejects.toThrow();
  });

  it('rejects a missing candidate image before publication', async () => {
    const fixture = await transferFixture({ missingImage: true });

    await expect(
      transferAcceptedCandidate(fixture.preflight, fixture.run)
    ).rejects.toThrow('Candidate image population differs from the recorder.');
    await expect(
      stat(join(fixture.run.runDirectory, 'output', 'candidate.zip'))
    ).rejects.toThrow();
  });

  it('never overwrites an already published candidate', async () => {
    const fixture = await transferFixture();
    const first = await transferAcceptedCandidate(
      fixture.preflight,
      fixture.run
    );
    const bytes = await readFile(first.outputPath);

    await expect(
      transferAcceptedCandidate(fixture.preflight, fixture.run)
    ).rejects.toThrow('Transfer output already exists.');
    expect(await readFile(first.outputPath)).toEqual(bytes);
  });

  it('does not retry an interrupted publication attempt', async () => {
    const fixture = await transferFixture();
    await writeFile(
      join(
        fixture.run.runDirectory,
        'evidence',
        'zip-publication-attempt.json'
      ),
      '{}'
    );

    await expect(
      transferAcceptedCandidate(fixture.preflight, fixture.run)
    ).rejects.toThrow('Transfer output already exists.');
    await expect(
      stat(join(fixture.run.runDirectory, 'output', 'candidate.zip'))
    ).rejects.toThrow();
  });

  it('rejects a moved anchor even when the supplied geometry receipt says Pass', async () => {
    const fixture = await transferFixture({ movedAnchor: true });

    await expect(
      transferAcceptedCandidate(fixture.preflight, fixture.run)
    ).rejects.toThrow('Reopened ZIP failed pose/frame safety');
    await expect(
      stat(join(fixture.run.runDirectory, 'output', 'candidate.zip'))
    ).rejects.toThrow();
  });

  it('rejects a pre-BA policy that differs from the frozen acceptance policy', async () => {
    const fixture = await transferFixture({ changedPolicy: true });

    await expect(
      transferAcceptedCandidate(fixture.preflight, fixture.run)
    ).rejects.toThrow('Frozen pre-BA policy changed before transfer.');
    await expect(
      stat(join(fixture.run.runDirectory, 'output', 'candidate.zip'))
    ).rejects.toThrow();
  });
});

async function transferFixture(
  options: {
    readonly missingImage?: boolean;
    readonly movedAnchor?: boolean;
    readonly changedPolicy?: boolean;
  } = {}
) {
  const runDirectory = await mkdtemp(join(tmpdir(), 'pose-transfer-'));
  temporaryDirectories.push(runDirectory);
  await Promise.all(
    [
      'input',
      'metrics',
      'evidence',
      'database',
      'models/triangulated',
      'exports/triangulated',
      'exports/adjusted',
    ].map((path) => mkdir(join(runDirectory, path), { recursive: true }))
  );
  const inputBytes = await recorderZip();
  await writeFile(join(runDirectory, 'input', 'original.zip'), inputBytes);
  const dataset = await readRecorderZip(inputBytes);
  const cameras = '41 PINHOLE 640 480 500 500 320 240\n';
  const images = [
    '20 1 0 0 0 0.5 0 0 41 frame-000001.jpg',
    '100 100 1 200 200 1',
    `5 1 0 0 0 0 ${options.movedAnchor ? 0.05 : 0} 0 41 frame-000002.jpg`,
    '101 101 1 201 201 1',
    ...(options.missingImage
      ? []
      : ['80 1 0 0 0 -0.5 0 0 41 frame-000003.jpg', '102 102 1 202 202 1']),
    '',
  ].join('\n');
  const points = '1 9 9 9 255 0 0 0.1 20 0 5 0 80 0\n';
  const exportDirectory = join(runDirectory, 'exports', 'adjusted');
  await Promise.all([
    writeFile(join(exportDirectory, 'cameras.txt'), cameras),
    writeFile(join(exportDirectory, 'images.txt'), images),
    writeFile(join(exportDirectory, 'points3D.txt'), points),
    writeFile(join(runDirectory, 'exports', 'triangulated', 'cameras.txt'), cameras),
    writeFile(join(runDirectory, 'exports', 'triangulated', 'images.txt'), images),
    writeFile(join(runDirectory, 'exports', 'triangulated', 'points3D.txt'), points),
  ]);
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
  const correspondenceText = '{}';
  await Promise.all([
    writeFile(join(runDirectory, 'database', 'selected.db'), databaseBytes),
    ...binaryFiles.map((filename) =>
      writeFile(
        join(runDirectory, 'models', 'triangulated', filename),
        binaryBytes[filename]!
      )
    ),
    writeFile(
      join(runDirectory, 'metrics', 'correspondences.json'),
      correspondenceText
    ),
  ]);
  const frozenBindings = {
    inputSha256: sha256(inputBytes),
    matchingDatabase: {
      path: 'database/selected.db',
      sha256: sha256(databaseBytes),
    },
    triangulatedModel: {
      'cameras.txt': sha256(cameras),
      'images.txt': sha256(images),
      'points3D.txt': sha256(points),
    },
    triangulatedBinaryModel: Object.fromEntries(
      binaryFiles.map((filename) => [filename, sha256(binaryBytes[filename]!)])
    ),
    correspondencesSha256: sha256(correspondenceText),
  };
  const preBaText = JSON.stringify({
    bindings: frozenBindings,
    policy: options.changedPolicy
      ? { ...acceptancePolicy, improvementTolerancePx: -1 }
      : acceptancePolicy,
  });
  await writeFile(
    join(runDirectory, 'metrics', 'pre-ba-support.json'),
    preBaText
  );
  const exportHashes = {
    'cameras.txt': sha256(cameras),
    'images.txt': sha256(images),
    'points3D.txt': sha256(points),
  };
  const baResult = JSON.stringify({
    schemaVersion: 1,
    status: 'pass',
    exportHashes,
  });
  await writeFile(join(runDirectory, 'evidence', 'ba-result.json'), baResult);
  await writeFile(
    join(runDirectory, 'metrics', 'post-ba-safety.json'),
    JSON.stringify({
      schemaVersion: 1,
      verdict: 'Pass',
      finalAcceptance: false,
      nextRequiredGate: 'ZIP transfer and reopen verification',
      policy: acceptancePolicy,
      bindings: {
        inputSha256: sha256(inputBytes),
        baResultSha256: sha256(baResult),
        preBaSupportSha256: sha256(preBaText),
        correspondencesSha256: sha256(correspondenceText),
        optimizationInputs: frozenBindings,
      },
    })
  );
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
      anchors: ['frame-000001.jpg', 'frame-000002.jpg', 'frame-000003.jpg'],
      loopPairs: [['frame-000001.jpg', 'frame-000003.jpg']],
    },
    dataset,
    inputZipBytes: inputBytes,
    inputSha256: sha256(inputBytes),
    sequentialPairs: [
      ['frame-000001.jpg', 'frame-000002.jpg'],
      ['frame-000002.jpg', 'frame-000003.jpg'],
    ],
  };
  return {
    inputBytes,
    preflight,
    run: {
      runDirectory,
      resolvedConfigPath: join(runDirectory, 'resolved-config.json'),
    },
  };
}

async function recorderZip(): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  const add = (path: string, bytes: Uint8Array) =>
    writer.add(path, new Uint8ArrayReader(bytes));
  const encoder = new TextEncoder();
  await add(
    'sparse/0/cameras.txt',
    encoder.encode('1 PINHOLE 640 480 500 500 320 240\n')
  );
  await add(
    'sparse/0/images.txt',
    encoder.encode(
      [
        '1 1 0 0 0 0.5 0 0 1 frame-000001.jpg',
        '',
        '2 1 0 0 0 0 0 0 1 frame-000002.jpg',
        '',
        '3 1 0 0 0 -0.5 0 0 1 frame-000003.jpg',
        '',
      ].join('\n')
    )
  );
  await add('sparse/0/points3D.txt', encoder.encode('1 0 0 1 255 0 0 0.1\n'));
  for (const [index, name] of [
    'frame-000001.jpg',
    'frame-000002.jpg',
    'frame-000003.jpg',
  ].entries()) {
    await add(`images/${name}`, new Uint8Array([255, 216, index, 255, 217]));
  }
  await add('images/unreferenced.jpg', new Uint8Array([9, 8, 7]));
  await add('actions/events.json', encoder.encode('{"kept":true}'));
  await add('session.json', encoder.encode('{"session":"kept"}'));
  await add('future/unknown.bin', new Uint8Array([6, 5, 4]));
  return writer.close();
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function zipFiles(bytes: Uint8Array) {
  const reader = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    return new Map(
      await Promise.all(
        (await reader.getEntries())
          .filter((entry) => !entry.directory)
          .map(
            async (entry) =>
              [
                entry.filename,
                await entry.getData(new Uint8ArrayWriter()),
              ] as const
          )
      )
    );
  } finally {
    await reader.close();
  }
}
