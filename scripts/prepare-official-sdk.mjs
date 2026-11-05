import process from 'node:process';
// Build the official release SDK for integration tests, without publishing or patching it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'runtime/openshell-source');
const commit = 'ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47';
await mkdir(resolve(root, 'runtime'), { recursive: true });
try {
    await access(resolve(source, '.git'));
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
    execFileSync(
        'git',
        [
            'clone',
            '--depth',
            '1',
            '--branch',
            'v0.1.6',
            'https://github.com/NVIDIA/OpenShell.git',
            source,
        ],
        { stdio: 'inherit' },
    );
}
assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: source,
        encoding: 'utf8',
    }).trim(),
    commit,
    'official SDK source revision mismatch',
);
assert.equal(
    execFileSync(
        'git',
        [
            'status',
            '--porcelain',
            '--',
            'sdk/typescript',
            'proto',
            'buf.yaml',
            'buf.lock',
        ],
        { cwd: source, encoding: 'utf8' },
    ).trim(),
    '',
    'official source changed',
);
const sdk = resolve(source, 'sdk/typescript');
try {
    await access(resolve(sdk, 'dist/index.js'));
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
    execFileSync(
        'npm',
        [
            'ci',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            '--cache',
            resolve(root, 'runtime/npm-cache'),
            '--fetch-timeout=20000',
            '--fetch-retries=1',
        ],
        { cwd: sdk, stdio: 'inherit' },
    );
    execFileSync('npm', ['run', 'gen'], {
        cwd: sdk,
        stdio: 'inherit',
        env: {
            ...process.env,
            BUF_CACHE_DIR: resolve(root, 'runtime/buf-cache'),
        },
    });
    execFileSync('npm', ['run', 'build'], { cwd: sdk, stdio: 'inherit' });
}
