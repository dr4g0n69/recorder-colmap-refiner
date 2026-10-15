import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../dist/src/bin.js', import.meta.url));
const driverPath = fileURLToPath(
  new URL('../dist/scripts/three-anchor-ba.py', import.meta.url)
);

await access(driverPath);

const result = spawnSync(process.execPath, [cliPath], { encoding: 'utf8' });

assert.equal(result.status, 1);
assert.match(
  result.stdout,
  /Usage: recorder-colmap-refiner refine --config <run\.json>/
);
assert.doesNotMatch(result.stderr, /Error:|ERR_/);
