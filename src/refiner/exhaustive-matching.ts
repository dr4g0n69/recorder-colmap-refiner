import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { exhaustiveMatchingCommand } from './colmap-commands.js';
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
): Promise<void> {
  const databasePath = join(run.runDirectory, 'database', 'exhaustive.db');
  const before = readMatchCounts(databasePath);
  const beforeSha256 = await fileSha256(databasePath);

  await executeNativeCommand(
    exhaustiveMatchingCommand(
      preflight.config.colmap.executable,
      run.runDirectory
    ),
    executor,
    join(run.runDirectory, 'logs'),
    2
  );

  const after = readMatchCounts(databasePath);
  if (
    after.verifiedMatches.correspondences <=
    before.verifiedMatches.correspondences
  ) {
    throw new Error('exhaustive matcher added no verified correspondences.');
  }
  if (after.rawMatches.correspondences <= before.rawMatches.correspondences) {
    throw new Error('exhaustive matcher added no raw correspondences.');
  }

  await writeFile(
    join(run.runDirectory, 'evidence', 'exhaustive-matching.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        database: {
          path: 'database/exhaustive.db',
          beforeSha256,
          afterSha256: await fileSha256(databasePath),
        },
        rawMatches: {
          before: before.rawMatches,
          after: after.rawMatches,
        },
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
