import { readFile } from 'node:fs/promises';

type WriteMessage = (message: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
    const config: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    if (
      !isRecord(config) ||
      !Array.isArray(config.anchors) ||
      config.anchors.length !== 3 ||
      !config.anchors.every(
        (anchor) => typeof anchor === 'string' && anchor.length > 0
      )
    ) {
      writeMessage(
        'Configuration error: anchors must contain exactly three image names.'
      );
      return 1;
    }

    writeMessage('Pipeline execution is not implemented yet.');
    return 1;
  } catch (error) {
    writeMessage(
      `Configuration error: ${error instanceof Error ? error.message : String(error)}`
    );
    return 1;
  }
}
