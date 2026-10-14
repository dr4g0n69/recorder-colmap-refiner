import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RefinerPreflight } from './preflight.js';

export interface PreparedRun {
  readonly runDirectory: string;
  readonly resolvedConfigPath: string;
}

export async function createPreparedRun(
  preflight: RefinerPreflight
): Promise<PreparedRun> {
  await mkdir(preflight.config.outputDirectory, { recursive: true });
  const runDirectory = await mkdtemp(
    join(preflight.config.outputDirectory, 'run-')
  );
  const resolvedConfigPath = join(runDirectory, 'resolved-config.json');
  const record = {
    schemaVersion: 1,
    inputZip: {
      path: preflight.config.inputZip,
      sha256: preflight.inputSha256,
    },
    outputDirectory: preflight.config.outputDirectory,
    colmap: preflight.config.colmap,
    anchors: preflight.config.anchors,
    loopPairs: preflight.config.loopPairs,
    sequentialPairs: preflight.sequentialPairs,
    imageCount: preflight.dataset.model.images.length,
  } as const;

  try {
    await writeFile(resolvedConfigPath, `${JSON.stringify(record, null, 2)}\n`, {
      flag: 'wx',
    });
  } catch (error) {
    await rm(runDirectory, { force: true, recursive: true });
    throw error;
  }

  return { runDirectory, resolvedConfigPath };
}
