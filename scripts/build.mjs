import { execFileSync } from 'node:child_process';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
const root = resolve(import.meta.dirname, '..');
await rm(resolve(root, 'dist'), { recursive: true, force: true });
execFileSync(
    process.execPath,
    [
        resolve(root, 'node_modules/typescript/bin/tsc'),
        '--noEmit',
        'false',
        '--declaration',
        '--rewriteRelativeImportExtensions',
        '--outDir',
        'dist',
    ],
    { cwd: root, stdio: 'inherit' },
);
await mkdir(resolve(root, 'dist/runtime'), { recursive: true });
for (const file of [
    'confine.mjs',
    'fs.mjs',
    'package.json',
    'package-lock.json',
])
    await copyFile(
        resolve(root, 'src/runtime', file),
        resolve(root, 'dist/runtime', file),
    );
