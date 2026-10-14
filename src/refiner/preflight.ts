import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { readRecorderZip, type RecorderDataset } from '../colmap/index.js';

export interface RefinerRunConfig {
  readonly inputZip: string;
  readonly outputDirectory: string;
  readonly anchors: readonly [string, string, string];
  readonly loopPairs: readonly (readonly [string, string])[];
}

export interface RefinerPreflight {
  readonly config: RefinerRunConfig;
  readonly dataset: RecorderDataset;
}

export async function preflightRunConfig(
  configPath: string
): Promise<RefinerPreflight> {
  const raw: unknown = JSON.parse(await readFile(configPath, 'utf8'));
  if (!isRecord(raw)) {
    throw new Error('configuration must be a JSON object.');
  }

  const anchors = parseAnchors(raw.anchors);
  const loopPairs = parseLoopPairs(raw.loopPairs);
  const configDirectory = dirname(resolve(configPath));
  const config: RefinerRunConfig = {
    inputZip: resolve(configDirectory, requiredPath(raw.inputZip, 'inputZip')),
    outputDirectory: resolve(
      configDirectory,
      requiredPath(raw.outputDirectory, 'outputDirectory')
    ),
    anchors,
    loopPairs,
  };
  const dataset = await readRecorderZip(
    new Uint8Array(await readFile(config.inputZip))
  );
  const imageNames = new Set(dataset.model.images.map((image) => image.name));

  for (const anchor of config.anchors) {
    requireModelImage(anchor, 'anchor', imageNames);
  }
  for (const pair of config.loopPairs) {
    for (const imageName of pair) {
      requireModelImage(imageName, 'loop-pair', imageNames);
    }
  }

  return { config, dataset };
}

function parseAnchors(value: unknown): readonly [string, string, string] {
  if (
    !isImageTriple(value) ||
    new Set(value).size !== 3
  ) {
    throw new Error('anchors must contain exactly three image names.');
  }
  return value;
}

function parseLoopPairs(
  value: unknown
): readonly (readonly [string, string])[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('loopPairs must contain at least one image pair.');
  }

  return value.map((pair, index) => {
    if (
      !isImagePair(pair) ||
      pair[0] === pair[1]
    ) {
      throw new Error(
        `loopPairs[${index}] must contain two distinct image names.`
      );
    }
    return [pair[0], pair[1]];
  });
}

function requiredPath(value: unknown, field: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`${field} must be a non-empty path.`);
  }
  return value;
}

function requireModelImage(
  imageName: string,
  role: 'anchor' | 'loop-pair',
  imageNames: ReadonlySet<string>
): void {
  if (!imageNames.has(imageName)) {
    throw new Error(
      `${role} image ${imageName} is absent from the recorder model.`
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isImageTriple(value: unknown): value is [string, string, string] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(isNonEmptyString)
  );
}

function isImagePair(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(isNonEmptyString)
  );
}
