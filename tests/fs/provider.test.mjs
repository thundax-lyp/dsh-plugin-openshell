import assert from 'node:assert/strict';
import console from 'node:console';
import { Context } from '@deepseek-ai/cordis';
import { FsError } from '@deepseek-ai/dsh-fs';
import { apply } from '../../src/index.ts';
import { fileClient } from '../fixtures/fs/client.mjs';
const { client, state } = fileClient();
const a = new Context(),
    b = new Context();
const config = {
    interactiveClient: client,
    sandbox: 'box-a',
    helper: '/opt/dsh-runtime/confine.mjs',
    workspaceRoot: '/sandbox/project',
};
try {
    await apply(a, config);
    await apply(b, { ...config, sandbox: 'box-b' });
    state.value = {
        targetKey: '/sandbox/project/中文.txt',
        displayPath: '/sandbox/project/中文.txt',
    };
    const target = await a.fs.resolve('中文.txt');
    const other = await b.fs.resolve('中文.txt');
    assert.notEqual(target.targetKey, other.targetKey);
    assert.throws(() => a.fs.processPath(other), /another execution world/);
    assert.equal(a.fs.processPath(target), '/sandbox/project/中文.txt');
    assert.equal(
        a.fs.fileUrl(target),
        'file:///sandbox/project/%E4%B8%AD%E6%96%87.txt',
    );
    assert.equal(a.fs.processPathFromHostPath(import.meta.filename), undefined);
    const call = state.calls[0];
    assert.equal(call.options.workdir, config.workspaceRoot);
    assert.equal(call.name, config.sandbox);
    assert.deepEqual(call.argv, [
        '/usr/local/bin/node',
        '/opt/dsh-runtime/fs.mjs',
    ]);
    assert.equal(call.request.cwd, config.workspaceRoot);
    state.value = '跨帧 UTF-8';
    assert.equal(await a.fs.readText(target), state.value);
    state.error = { code: 'FS_STALE_VERSION', message: 'stale' };
    await assert.rejects(
        a.fs.editText(target, {
            oldString: 'a',
            newString: 'b',
            replaceAll: false,
        }),
        (e) => e instanceof FsError && e.code === 'FS_STALE_VERSION',
    );
    assert.equal(state.calls.at(-1).request.policy.mode, 'read-only');
    state.error = undefined;
    state.value = { operation: 'update', version: 'v2', before: '', after: '' };
    await a.fs.writeText(target, 'x'.repeat(1024 * 1024));
    assert.equal(state.calls.at(-1).request.content.length, 1024 * 1024);
    assert(state.calls.at(-1).sizes.length > 1);
    assert(state.calls.at(-1).sizes.every((size) => size <= 65536));
    await assert.rejects(
        a.fs.streamText(target, globalThis.AbortSignal.abort()),
        (e) => e.code === 'FS_ABORTED',
    );
    state.version = 'wrong';
    await assert.rejects(
        a.fs.readText(target),
        (e) => e.code === 'FS_IO_ERROR',
    );
    state.version = '0.2.1-rc.4';
    const count = state.calls.length;
    await assert.rejects(
        a.fs.readText(target, globalThis.AbortSignal.abort()),
        (e) => e.code === 'FS_ABORTED',
    );
    await assert.rejects(
        a.fs.readByteRange(target, { offset: 0, length: 2 ** 30 }),
        (e) => e.code === 'FS_TOO_LARGE',
    );
    await assert.rejects(
        () =>
            a.fs.writeText(target, '', undefined, undefined, {
                mode: 'workspace-write',
                workspaceRoot: '/sandbox',
            }),
        (e) => e.code === 'FS_SANDBOX_DENIED',
    );
    await assert.rejects(
        a.fs.writeText(target, 'x'.repeat(2 ** 21)),
        (e) => e.code === 'FS_TOO_LARGE',
    );
    assert.equal(state.calls.length, count);
    const fs = a.fs;
    await a.fiber.dispose();
    await assert.rejects(fs.readText(target), (e) => e.code === 'FS_ABORTED');
    console.log(
        'PASS: filesystem SDK stdin protocol, split UTF-8, workspace defaults, target isolation, typed errors, caps and abort/dispose',
    );
} finally {
    await b.fiber.dispose();
    await a.fiber.dispose();
}
