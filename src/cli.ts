import { preflightRunConfig } from './refiner/preflight.js';
import { createPreparedRun } from './refiner/run-directory.js';
import { materializeRunWorkspace } from './refiner/workspace.js';
import {
  spawnNativeCommand,
  type NativeCommandExecutor,
} from './refiner/native-command.js';
import { runFeatureExtraction } from './refiner/feature-extraction.js';
import { verifyAndFreezeFeatureDatabase } from './refiner/database-handoff.js';
import { runExhaustiveMatching } from './refiner/exhaustive-matching.js';
import { runFixedPoseTriangulation } from './refiner/triangulation.js';

type WriteMessage = (message: string) => void;

export async function runRefinerCli(
  args: readonly string[],
  writeMessage: WriteMessage,
  executor: NativeCommandExecutor = spawnNativeCommand
): Promise<number> {
  const [command, flag, configPath, ...extra] = args;
  if (
    command !== 'refine' ||
    flag !== '--config' ||
    configPath === undefined ||
    extra.length !== 0
  ) {
    writeMessage('Usage: recorder-colmap-refiner refine --config <run.json>');
    return 1;
  }

  let preflight;
  try {
    preflight = await preflightRunConfig(configPath);
  } catch (error) {
    writeMessage(
      `Configuration error: ${error instanceof Error ? error.message : String(error)}`
    );
    return 1;
  }

  let run;
  try {
    run = await createPreparedRun(preflight);
    await materializeRunWorkspace(preflight, run);
    writeMessage(`Prepared run: ${run.runDirectory}`);
  } catch (error) {
    writeMessage(
      `Preparation error: ${error instanceof Error ? error.message : String(error)}`
    );
    return 1;
  }

  try {
    await runFeatureExtraction(preflight, run, executor);
    writeMessage('Feature extraction: complete');
    await verifyAndFreezeFeatureDatabase(preflight, run);
    writeMessage('Feature database identity: verified');
    await runExhaustiveMatching(preflight, run, executor);
    writeMessage('Exhaustive matching: complete');
    await runFixedPoseTriangulation(preflight, run, executor);
    writeMessage('Fixed-pose triangulation: complete');
    writeMessage('Pipeline execution is not implemented yet.');
    return 1;
  } catch (error) {
    writeMessage(
      `Execution error: ${error instanceof Error ? error.message : String(error)}`
    );
    return 1;
  }
}
