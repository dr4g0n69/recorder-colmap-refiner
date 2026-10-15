import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  exhaustiveMatchingCommand,
  selectedMatchingCommand,
} from './colmap-commands.js';
import {
  executeNativeCommand,
  type NativeCommandExecutor,
} from './native-command.js';
import type { RefinerPreflight } from './preflight.js';
import type { PreparedRun } from './run-directory.js';

interface MatchCounts {
  readonly pairs: number;
  readonly correspondences: number;
}

export async function runExhaustiveMatching(
  preflight: RefinerPreflight,
  run: PreparedRun,
  executor: NativeCommandExecutor
): Promise<string> {
  const databasePath = join(run.runDirectory, 'database', 'exhaustive.db');
  try {
    await runAttempt(
      databasePath,
      'database/exhaustive.db',
      'exhaustive-matching.json',
      exhaustiveMatchingCommand(
        preflight.config.colmap.executable,
        run.runDirectory
      ),
      run,
      executor,
      2
    );
    return 'database/exhaustive.db';
  } catch (error) {
    const featuresPath = join(run.runDirectory, 'database', 'features.db');
    const selectedPath = join(run.runDirectory, 'database', 'selected.db');
    await copyFile(featuresPath, selectedPath, constants.COPYFILE_EXCL);
    if ((await fileSha256(featuresPath)) !== (await fileSha256(selectedPath))) {
      throw new Error('selected.db does not match the frozen feature database.');
    }
    const pairs = new Map<string, readonly [string, string]>();
    for (const pair of [
      ...preflight.sequentialPairs,
      ...preflight.config.loopPairs,
    ]) {
      pairs.set([...pair].sort().join('\0'), pair);
    }
    await writeFile(
      join(run.runDirectory, 'evidence', 'selected-pairs.txt'),
      `${[...pairs.values()].map((pair) => pair.join(' ')).join('\n')}\n`,
      { flag: 'wx' }
    );
    await runAttempt(
      selectedPath,
      'database/selected.db',
      'selected-matching.json',
      selectedMatchingCommand(
        preflight.config.colmap.executable,
        run.runDirectory
      ),
      run,
      executor,
      3,
      error instanceof Error ? error.message : String(error)
    );
    return 'database/selected.db';
  }
}

async function runAttempt(
  databasePath: string,
  relativePath: string,
  evidenceName: string,
  command: ReturnType<typeof exhaustiveMatchingCommand>,
  run: PreparedRun,
  executor: NativeCommandExecutor,
  logIndex: number,
  exhaustiveFailure?: string
): Promise<void> {
  const before = readMatchCounts(databasePath);
  const beforeSha256 = await fileSha256(databasePath);
  await executeNativeCommand(
    command,
    executor,
    join(run.runDirectory, 'logs'),
    logIndex
  );
  const after = readMatchCounts(databasePath);
  if (
    after.verifiedMatches.correspondences <=
    before.verifiedMatches.correspondences
  ) {
    throw new Error('matcher added no verified correspondences.');
  }
  if (after.rawMatches.correspondences <= before.rawMatches.correspondences) {
    throw new Error('matcher added no raw correspondences.');
  }
  await writeFile(
    join(run.runDirectory, 'evidence', evidenceName),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        strategy: exhaustiveFailure ? 'selected-pairs-fallback' : 'exhaustive',
        exhaustiveFailure: exhaustiveFailure ?? null,
        database: {
          path: relativePath,
          beforeSha256,
          afterSha256: await fileSha256(databasePath),
        },
        rawMatches: { before: before.rawMatches, after: after.rawMatches },
        verifiedMatches: {
          before: before.verifiedMatches,
          after: after.verifiedMatches,
        },
      },
      null,
      2
    )}\n`,
    { flag: 'wx' }
  );
}

function readMatchCounts(path: string): {
  readonly rawMatches: MatchCounts;
  readonly verifiedMatches: MatchCounts;
} {
  const databasePath =
    process.platform === 'win32' && !path.startsWith('\\\\?\\')
      ? `\\\\?\\${resolve(path)}`
      : path;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      rawMatches: countRows(database, 'matches'),
      verifiedMatches: countRows(database, 'two_view_geometries'),
    };
  } finally {
    database.close();
  }
}

function countRows(database: DatabaseSync, table: string): MatchCounts {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  for (const [name, type] of [
    ['pair_id', 'INTEGER'],
    ['rows', 'INTEGER'],
  ] as const) {
    if (!columns.some((column) => column.name === name && column.type === type)) {
      throw new Error(
        `Unsupported database schema: ${table}.${name} must be ${type}.`
      );
    }
  }
  const row = database
    .prepare(
      `SELECT COUNT(*) AS pairs, COALESCE(SUM(rows), 0) AS correspondences FROM ${table} WHERE rows > 0`
    )
    .get();
  return {
    pairs: count(row?.pairs, `${table} pair count`),
    correspondences: count(
      row?.correspondences,
      `${table} correspondence count`
    ),
  };
}

function count(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

async function fileSha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
