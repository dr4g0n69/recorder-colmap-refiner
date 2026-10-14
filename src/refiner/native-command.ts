import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface NativeCommand {
  readonly stage: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
}

export interface NativeCommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type NativeCommandExecutor = (
  command: NativeCommand
) => Promise<NativeCommandResult>;

export class NativeCommandError extends Error {
  readonly stage: string;
  readonly exitCode: number | null;

  constructor(stage: string, exitCode: number | null, message: string) {
    super(message);
    this.name = 'NativeCommandError';
    this.stage = stage;
    this.exitCode = exitCode;
  }
}

export async function executeNativeCommands(
  commands: readonly NativeCommand[],
  executor: NativeCommandExecutor,
  logsDirectory: string
): Promise<void> {
  await mkdir(logsDirectory, { recursive: true });

  for (const [index, command] of commands.entries()) {
    validateStage(command.stage);
    const prefix = `${String(index + 1).padStart(2, '0')}-${command.stage}`;
    await writeJson(
      join(logsDirectory, `${prefix}-command.json`),
      { schemaVersion: 1, ...command },
      'wx'
    );

    const startedAt = new Date();
    let result: NativeCommandResult;
    try {
      result = await executor(command);
    } catch (error) {
      const finishedAt = new Date();
      await writeJson(
        join(logsDirectory, `${prefix}-result.json`),
        {
          schemaVersion: 1,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          elapsedMs: finishedAt.getTime() - startedAt.getTime(),
          exitCode: null,
          signal: null,
          error: error instanceof Error ? error.message : String(error),
        },
        'wx'
      );
      throw new NativeCommandError(
        command.stage,
        null,
        `${command.stage} could not be started.`
      );
    }

    const finishedAt = new Date();
    await Promise.all([
      writeFile(join(logsDirectory, `${prefix}-stdout.log`), result.stdout, {
        flag: 'wx',
      }),
      writeFile(join(logsDirectory, `${prefix}-stderr.log`), result.stderr, {
        flag: 'wx',
      }),
      writeJson(
        join(logsDirectory, `${prefix}-result.json`),
        {
          schemaVersion: 1,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          elapsedMs: finishedAt.getTime() - startedAt.getTime(),
          exitCode: result.exitCode,
          signal: result.signal,
        },
        'wx'
      ),
    ]);

    if (result.exitCode !== 0) {
      throw new NativeCommandError(
        command.stage,
        result.exitCode,
        `${command.stage} failed with exit code ${String(result.exitCode)}.`
      );
    }
  }
}

export const spawnNativeCommand: NativeCommandExecutor = (command) =>
  new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      cwd: command.cwd,
      shell: false,
      timeout: command.timeoutMs,
      windowsHide: true,
    });
    // shortcut: process output is buffered, stream it if real COLMAP logs become large.
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => {
      resolve({ exitCode, signal, stdout, stderr });
    });
  });

function validateStage(stage: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(stage)) {
    throw new Error(`Invalid native command stage: ${stage}`);
  }
}

async function writeJson(
  path: string,
  value: unknown,
  flag: 'wx'
): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag });
}
