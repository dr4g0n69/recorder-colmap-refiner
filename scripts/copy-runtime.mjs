import { copyFile, mkdir, rm } from 'node:fs/promises';

const outputDirectory = new URL('../dist/scripts/', import.meta.url);

await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await copyFile(
  new URL('./three-anchor-ba.py', import.meta.url),
  new URL('./three-anchor-ba.py', outputDirectory)
);
