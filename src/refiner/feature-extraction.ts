import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  colmapIdentityCommand,
  featureExtractionCommand,
} from './colmap-commands.js';
import {
  executeNativeCommand,
  type NativeCommandExecutor,
} from './native-command.js';
import type { RefinerPreflight } from './preflight.js';
import type { PreparedRun } from './run-directory.js';

export async function runFeatureExtraction(
  preflight: RefinerPreflight,
  run: PreparedRun,
  executor: NativeCommandExecutor
): Promise<void> {
  const logsDirectory = join(run.runDirectory, 'logs');
  const identity = await executeNativeCommand(
    colmapIdentityCommand(
      preflight.config.colmap.executable,
      run.runDirectory
    ),
    executor,
    logsDirectory,
    0
  );
  const help = `${identity.stdout}\n${identity.stderr}`;
  if (
    !help.includes(preflight.config.colmap.version) ||
    !help.includes(preflight.config.colmap.build)
  ) {
    throw new Error(
      'COLMAP help does not match configured version/build identity.'
    );
  }

  const [camera] = preflight.dataset.model.cameras;
  if (camera === undefined || preflight.dataset.model.cameras.length !== 1) {
    throw new Error('Feature extraction requires exactly one recorder camera.');
  }
  await executeNativeCommand(
    featureExtractionCommand(
      preflight.config.colmap.executable,
      run.runDirectory,
      camera
    ),
    executor,
    logsDirectory,
    1
  );

  const featuresPath = join(run.runDirectory, 'database', 'features.db');
  const featuresBytes = await readFile(featuresPath);
  const featuresSha256 = createHash('sha256')
    .update(featuresBytes)
    .digest('hex');
  await writeFile(
    join(run.runDirectory, 'evidence', 'feature-extraction.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        featuresDatabase: {
          path: 'database/features.db',
          sha256: featuresSha256,
        },
      },
      null,
      2
    )}\n`,
    { flag: 'wx' }
  );
}
