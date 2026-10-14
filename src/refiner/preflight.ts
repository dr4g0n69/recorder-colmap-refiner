import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { readRecorderZip, type RecorderDataset } from '../colmap/index.js';

export interface RefinerRunConfig {
  readonly inputZip: string;
  readonly outputDirectory: string;
  readonly colmap: ColmapIdentity;
  readonly python: PythonIdentity;
  readonly anchors: readonly [string, string, string];
  readonly loopPairs: readonly (readonly [string, string])[];
}

export interface ColmapIdentity {
  readonly executable: string;
  readonly version: string;
  readonly build: string;
  readonly sha256: string;
}

export interface PythonIdentity {
  readonly executable: string;
  readonly sha256: string;
  readonly pycolmapVersion: string;
}

export interface RefinerPreflight {
  readonly config: RefinerRunConfig;
  readonly dataset: RecorderDataset;
  readonly inputZipBytes: Uint8Array;
  readonly inputSha256: string;
  readonly sequentialPairs: readonly (readonly [string, string])[];
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
  const colmap = await parseColmapIdentity(raw.colmap, configDirectory);
  const python = await parsePythonIdentity(raw.python, configDirectory);
  const config: RefinerRunConfig = {
    inputZip: resolve(configDirectory, requiredPath(raw.inputZip, 'inputZip')),
    outputDirectory: resolve(
      configDirectory,
      requiredPath(raw.outputDirectory, 'outputDirectory')
    ),
    colmap,
    python,
    anchors,
    loopPairs,
  };
  const inputZipBytes = new Uint8Array(await readFile(config.inputZip));
  const dataset = await readRecorderZip(inputZipBytes);
  const imageNames = new Set(dataset.model.images.map((image) => image.name));

  for (const anchor of config.anchors) {
    requireModelImage(anchor, 'anchor', imageNames);
  }
  for (const pair of config.loopPairs) {
    for (const imageName of pair) {
      requireModelImage(imageName, 'loop-pair', imageNames);
    }
  }

  return {
    config,
    dataset,
    inputZipBytes,
    inputSha256: createHash('sha256').update(inputZipBytes).digest('hex'),
    sequentialPairs: adjacentImagePairs(
      dataset.model.images.map((image) => image.name)
    ),
  };
}

async function parsePythonIdentity(
  value: unknown,
  configDirectory: string
): Promise<PythonIdentity> {
  if (!isRecord(value)) {
    throw new Error('python must define the offline PyCOLMAP runtime.');
  }
  const executable = resolve(
    configDirectory,
    requiredString(value.executable, 'python.executable')
  );
  const sha256 = requiredString(value.sha256, 'python.sha256').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('python.sha256 must be a 64-character hexadecimal hash.');
  }
  const actualHash = createHash('sha256')
    .update(await readFile(executable))
    .digest('hex');
  if (actualHash !== sha256) {
    throw new Error(
      'Python executable SHA-256 does not match the configured identity.'
    );
  }
  return {
    executable,
    sha256,
    pycolmapVersion: requiredString(
      value.pycolmapVersion,
      'python.pycolmapVersion'
    ),
  };
}

async function parseColmapIdentity(
  value: unknown,
  configDirectory: string
): Promise<ColmapIdentity> {
  if (!isRecord(value)) {
    throw new Error('colmap must define an executable identity.');
  }
  const executable = resolve(
    configDirectory,
    requiredString(value.executable, 'colmap.executable')
  );
  const version = requiredString(value.version, 'colmap.version');
  const build = requiredString(value.build, 'colmap.build');
  const sha256 = requiredString(value.sha256, 'colmap.sha256').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('colmap.sha256 must be a 64-character hexadecimal hash.');
  }
  const actualHash = createHash('sha256')
    .update(await readFile(executable))
    .digest('hex');
  if (actualHash !== sha256) {
    throw new Error(
      'COLMAP executable SHA-256 does not match the configured identity.'
    );
  }
  return { executable, version, build, sha256 };
}

function adjacentImagePairs(
  imageNames: readonly string[]
): readonly (readonly [string, string])[] {
  return imageNames.slice(1).map((imageName, index) => [
    imageNames[index]!,
    imageName,
  ]);
}

function parseAnchors(value: unknown): readonly [string, string, string] {
  if (!isImageTriple(value) || new Set(value).size !== 3) {
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
    if (!isImagePair(pair) || pair[0] === pair[1]) {
      throw new Error(
        `loopPairs[${index}] must contain two distinct image names.`
      );
    }
    return [pair[0], pair[1]];
  });
}

function requiredPath(value: unknown, field: string): string {
  return requiredString(value, field, 'path');
}

function requiredString(
  value: unknown,
  field: string,
  description = 'value'
): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`${field} must be a non-empty ${description}.`);
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
