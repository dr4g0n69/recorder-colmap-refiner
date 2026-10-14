import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { PinholeCamera } from '../colmap/index.js';
import {
  exhaustiveMatchingCommand,
  featureExtractionCommand,
  modelConversionCommand,
  triangulationCommand,
} from './colmap-commands.js';
import {
  executeNativeCommands,
  NativeCommandError,
  type NativeCommand,
  type NativeCommandExecutor,
} from './native-command.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

describe('COLMAP command builders', () => {
  it('uses the reviewed baseline settings and run-relative artifacts', () => {
    const runDirectory = 'C:\\runs\\run-123';
    const executable = 'C:\\Tools\\COLMAP\\colmap.exe';
    const camera: PinholeCamera = {
      cameraId: 1,
      model: 'PINHOLE',
      width: 640,
      height: 480,
      intrinsics: { fx: 500, fy: 501, cx: 320, cy: 240 },
    };

    expect(featureExtractionCommand(executable, runDirectory, camera)).toEqual({
      stage: 'feature-extractor',
      executable,
      args: [
        'feature_extractor',
        '--database_path',
        'database/features.db',
        '--image_path',
        'images',
        '--ImageReader.single_camera',
        '1',
        '--ImageReader.camera_model',
        'PINHOLE',
        '--ImageReader.camera_params',
        '500,501,320,240',
        '--FeatureExtraction.use_gpu',
        '0',
        '--FeatureExtraction.num_threads',
        '4',
      ],
      cwd: runDirectory,
    });
    expect(exhaustiveMatchingCommand(executable, runDirectory)).toEqual({
      stage: 'exhaustive-matcher',
      executable,
      args: [
        'exhaustive_matcher',
        '--database_path',
        'database/exhaustive.db',
        '--FeatureMatching.use_gpu',
        '1',
        '--FeatureMatching.gpu_index',
        '0',
      ],
      cwd: runDirectory,
      timeoutMs: 30 * 60 * 1000,
    });
    expect(
      triangulationCommand(executable, runDirectory, 'database/exhaustive.db')
    ).toEqual({
      stage: 'point-triangulator',
      executable,
      args: [
        'point_triangulator',
        '--database_path',
        'database/exhaustive.db',
        '--image_path',
        'images',
        '--input_path',
        'models/known',
        '--output_path',
        'models/triangulated',
        '--Mapper.ba_refine_focal_length',
        '0',
        '--Mapper.ba_refine_principal_point',
        '0',
        '--Mapper.ba_refine_extra_params',
        '0',
        '--Mapper.tri_ignore_two_view_tracks',
        '0',
        '--Mapper.filter_max_reproj_error',
        '15',
      ],
      cwd: runDirectory,
    });
    expect(modelConversionCommand(executable, runDirectory)).toEqual({
      stage: 'model-converter',
      executable,
      args: [
        'model_converter',
        '--input_path',
        'models/triangulated',
        '--output_path',
        'exports/triangulated',
        '--output_type',
        'TXT',
      ],
      cwd: runDirectory,
    });
  });
});

describe('executeNativeCommands', () => {
  it('executes in order and records commands, output and results', async () => {
    const directory = await temporaryDirectory();
    const commands = exampleCommands(directory);
    const calls: NativeCommand[] = [];
    const executor: NativeCommandExecutor = async (command) => {
      calls.push(command);
      return {
        exitCode: 0,
        signal: null,
        stdout: `${command.stage} output`,
        stderr: '',
      };
    };

    await executeNativeCommands(commands, executor, join(directory, 'logs'));

    expect(calls).toEqual(commands);
    expect(await readdir(join(directory, 'logs'))).toEqual([
      '01-first-command.json',
      '01-first-result.json',
      '01-first-stderr.log',
      '01-first-stdout.log',
      '02-second-command.json',
      '02-second-result.json',
      '02-second-stderr.log',
      '02-second-stdout.log',
      '03-third-command.json',
      '03-third-result.json',
      '03-third-stderr.log',
      '03-third-stdout.log',
    ]);
    expect(
      JSON.parse(
        await readFile(
          join(directory, 'logs', '01-first-command.json'),
          'utf8'
        )
      )
    ).toEqual({ schemaVersion: 1, ...commands[0] });
    expect(
      await readFile(join(directory, 'logs', '02-second-stdout.log'), 'utf8')
    ).toBe('second output');
  });

  it('records a failed command and does not start later commands', async () => {
    const directory = await temporaryDirectory();
    const commands = exampleCommands(directory);
    const calls: NativeCommand[] = [];
    const executor: NativeCommandExecutor = async (command) => {
      calls.push(command);
      return {
        exitCode: command.stage === 'second' ? 7 : 0,
        signal: null,
        stdout: '',
        stderr: command.stage === 'second' ? 'failure' : '',
      };
    };

    await expect(
      executeNativeCommands(commands, executor, join(directory, 'logs'))
    ).rejects.toEqual(
      expect.objectContaining<Partial<NativeCommandError>>({
        name: 'NativeCommandError',
        stage: 'second',
        exitCode: 7,
      })
    );

    expect(calls.map((command) => command.stage)).toEqual(['first', 'second']);
    expect(
      JSON.parse(
        await readFile(
          join(directory, 'logs', '02-second-result.json'),
          'utf8'
        )
      )
    ).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        exitCode: 7,
        signal: null,
      })
    );
    expect(await readdir(join(directory, 'logs'))).not.toContain(
      '03-third-command.json'
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'recorder-colmap-refiner-'));
  temporaryDirectories.push(directory);
  return directory;
}

function exampleCommands(directory: string): readonly NativeCommand[] {
  return ['first', 'second', 'third'].map((stage) => ({
    stage,
    executable: 'example.exe',
    args: [stage],
    cwd: directory,
  }));
}
