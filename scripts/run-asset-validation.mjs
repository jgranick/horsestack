import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'rolldown';

const temporaryRoot = resolve('.tmp');
await mkdir(temporaryRoot, { recursive: true });
const temporaryDirectory = await mkdtemp(`${temporaryRoot}/asset-validation-`);
const bundlePath = resolve(temporaryDirectory, 'validate-assets.mjs');

try {
  await build({
    input: resolve('scripts/validate-assets.ts'),
    logLevel: 'silent',
    output: { file: bundlePath, format: 'esm' },
    platform: 'node',
  });
  await import(pathToFileURL(bundlePath).href);
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
