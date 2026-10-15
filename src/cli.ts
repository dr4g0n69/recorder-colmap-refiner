import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
import { verifyPreBaSupport } from './refiner/pre-ba-support.js';
import { inspectBundleAdjustment } from './refiner/ba-inspection.js';
import { runBundleAdjustment } from './refiner/ba-solve.js';
import { evaluatePostBaSafety } from './refiner/post-ba-safety.js';
import { transferAcceptedCandidate } from './refiner/pose-transfer.js';

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

  let stage = 'feature-extraction';
  try {
    await runFeatureExtraction(preflight, run, executor);
    writeMessage('Feature extraction: complete');
    stage = 'feature-database-verification';
    await verifyAndFreezeFeatureDatabase(preflight, run);
    writeMessage('Feature database identity: verified');
    stage = 'matching';
    const matchingDatabase = await runExhaustiveMatching(
      preflight,
      run,
      executor
    );
    writeMessage(`Matching: complete (${matchingDatabase})`);
    stage = 'triangulation';
    await runFixedPoseTriangulation(
      preflight,
      run,
      executor,
      matchingDatabase
    );
    writeMessage('Fixed-pose triangulation: complete');
    stage = 'pre-ba-support';
    await verifyPreBaSupport(preflight, run, matchingDatabase);
    writeMessage('Pre-BA support: verified');
    stage = 'ba-inspection';
    const inspectionBlocker = await inspectBundleAdjustment(
      preflight,
      run,
      executor
    );
    writeMessage('BA configuration: inspected without solving');
    if (inspectionBlocker !== null) {
      await writeTerminalResult(
        run.runDirectory,
        stage,
        'Inconclusive',
        inspectionBlocker
      );
      writeMessage('Bundle adjustment not started: Inconclusive');
      return 1;
    }
    stage = 'bundle-adjustment';
    await runBundleAdjustment(preflight, run, executor);
    writeMessage('Three-anchor bundle adjustment: complete');
    stage = 'post-ba-safety';
    const verdict = await evaluatePostBaSafety(preflight, run);
    writeMessage(`Post-BA geometry: ${verdict}`);
    if (verdict !== 'Pass') {
      await writeTerminalResult(run.runDirectory, stage, verdict, verdict);
      writeMessage(`Candidate ZIP not generated: ${verdict}`);
      return 1;
    }
    stage = 'zip-transfer';
    const transfer = await transferAcceptedCandidate(preflight, run);
    writeMessage(`Candidate ZIP: ${transfer.outputPath}`);
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await writeTerminalResult(run.runDirectory, stage, 'Failed', reason);
    } catch (reportError) {
      writeMessage(
        `Terminal report error: ${reportError instanceof Error ? reportError.message : String(reportError)}`
      );
    }
    writeMessage(`Execution error: ${reason}`);
    return 1;
  }
}

async function writeTerminalResult(
  runDirectory: string,
  stage: string,
  outcome: 'Delivered' | 'Rejected' | 'Inconclusive' | 'Failed',
  reason: string
) {
  await writeFile(
    join(runDirectory, 'run-result.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        completedAt: new Date().toISOString(),
        stage,
        outcome,
        reason,
      },
      null,
      2
    )}\n`,
    { flag: 'wx' }
  );
}
