import { preflightRunConfig } from './refiner/preflight.js';

type WriteMessage = (message: string) => void;

export async function runRefinerCli(
  args: readonly string[],
  writeMessage: WriteMessage
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

  try {
    await preflightRunConfig(configPath);
    writeMessage('Pipeline execution is not implemented yet.');
    return 1;
  } catch (error) {
    writeMessage(
      `Configuration error: ${error instanceof Error ? error.message : String(error)}`
    );
    return 1;
  }
}
