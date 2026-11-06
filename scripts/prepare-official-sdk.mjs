import process from 'node:process';
import { Buffer } from 'node:buffer';
// Build the official release SDK for integration tests, without publishing or patching it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const commit = 'ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47';
const checksum =
    'ef434dd44746c5ee14a24e8dc4f09654134ee362f5a09fb08d31eb27c81b02ad';
const source = resolve(root, `runtime/openshell-sdk-${commit}`);
const archive = resolve(root, 'runtime/openshell-source.tar.gz');
await mkdir(resolve(root, 'runtime'), { recursive: true });
try {
    await access(archive);
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await globalThis.fetch(
        `https://codeload.github.com/NVIDIA/OpenShell/tar.gz/${commit}`,
        { signal: globalThis.AbortSignal.timeout(120000) },
    );
    assert.ok(response.ok, `SDK source download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'), checksum);
    await writeFile(archive, bytes);
}
assert.equal(
    createHash('sha256')
        .update(await readFile(archive))
        .digest('hex'),
    checksum,
    'official SDK source archive checksum mismatch',
);
try {
    assert.equal(
        await readFile(resolve(source, '.source-checksum'), 'utf8'),
        checksum,
    );
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const staging = await mkdtemp(resolve(root, 'runtime/openshell-sdk-'));
    try {
        const prefix = `OpenShell-${commit}`;
        execFileSync(
            'tar',
            [
                '-xzf',
                archive,
                '-C',
                staging,
                '--strip-components=1',
                `${prefix}/sdk/typescript`,
                `${prefix}/proto`,
                `${prefix}/buf.yaml`,
                `${prefix}/LICENSE`,
            ],
            { stdio: 'inherit' },
        );
        await writeFile(resolve(staging, '.source-checksum'), checksum);
        await rename(staging, source);
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}
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
