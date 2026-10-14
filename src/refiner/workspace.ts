import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { recorderZipAdapter } from '../colmap/recorder-zip-adapter.js';
import type { RefinerPreflight } from './preflight.js';
import type { PreparedRun } from './run-directory.js';

const workspaceDirectories = [
  'input',
  'images',
  'database',
  'models/known',
  'models/triangulated',
  'exports/triangulated',
  'output',
  'logs',
  'metrics',
  'evidence',
] as const;

export async function materializeRunWorkspace(
  preflight: RefinerPreflight,
  run: PreparedRun
): Promise<void> {
  await Promise.all(
    workspaceDirectories.map((relativePath) =>
      mkdir(join(run.runDirectory, relativePath), { recursive: true })
    )
  );

  const copiedInputPath = join(run.runDirectory, 'input', 'original.zip');
  await writeFile(copiedInputPath, preflight.inputZipBytes, { flag: 'wx' });
  const copiedHash = createHash('sha256')
    .update(await readFile(copiedInputPath))
    .digest('hex');
  if (copiedHash !== preflight.inputSha256) {
    throw new Error('Copied input ZIP failed SHA-256 verification.');
  }

  const archive = await recorderZipAdapter.open(preflight.inputZipBytes);
  const images = recorderZipAdapter.resolveImages(
    archive,
    preflight.dataset.model.images
  );
  await Promise.all(
    images.map((image) =>
      writeFile(join(run.runDirectory, image.path), image.bytes, { flag: 'wx' })
    )
  );

}
