import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { FsError } from '@deepseek-ai/dsh-fs';
import { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory';
import {
    buildGlobCommand,
    parseGlobArgs,
    buildGrepCommand,
    parseGrepArgs,
    parseGrepMatches,
    resolveRgPath,
    runRipgrep,
} from '@deepseek-ai/dsh-tool-fs-search';
import { SandboxClient } from '../../sdk/dist/index.js';
import { apply } from '../../src/index.ts';
const root = process.argv[2];
const prepared = JSON.parse(
    await readFile(join(root, 'client/prepared.json'), 'utf8'),
);
const client = await SandboxClient.connect({
    gateway: 'http://127.0.0.1:18180',
});
const ctx = new Context(),
    other = new Context(),
    nested = new Context();
const workspaceRoot = '/sandbox/project';
const policy = { mode: 'workspace-write', workspaceRoot };
const readOnly = { mode: 'read-only', workspaceRoot };
const config = {
    interactiveClient: client,
    sandbox: prepared.runtime_sandbox.name,
    helper: prepared.helper_path,
    workspaceRoot,
    searchExecutable: {
        host: await resolveRgPath(),
        remote: '/opt/dsh-runtime/node_modules/@vscode/ripgrep-linux-x64/bin/rg',
    },
};
const denied = async (operation, code) =>
    assert.rejects(operation, (e) => e instanceof FsError && e.code === code);
try {
    await apply(ctx, config);
    await apply(other, { ...config, sandbox: prepared.sandboxes[1].name });
    assert.equal(ctx.openShellWorkspace.root, workspaceRoot);
    assert.equal(ctx.fs.sandboxMode, 'read-only');
    assert.equal(
        ctx.fs.processPathFromHostPath(import.meta.filename),
        undefined,
    );
    const target = await ctx.fs.resolve('fs-proof.txt');
    assert.equal(await ctx.fs.stat(target), undefined);
    await denied(
        () => ctx.fs.writeText(target, 'blocked'),
        'FS_SANDBOX_DENIED',
    );
    const write = await ctx.fs.writeText(
        target,
        '你好 marker\nalpha alpha\n',
        { kind: 'createIfAbsent' },
        undefined,
        policy,
    );
    await denied(
        () =>
            ctx.fs.writeText(
                target,
                'duplicate',
                { kind: 'createIfAbsent' },
                undefined,
                policy,
            ),
        'FS_NOT_OBSERVED',
    );
    assert.equal(await ctx.fs.readText(target), '你好 marker\nalpha alpha\n');
    assert.equal(
        Buffer.from(await ctx.fs.readBytes(target, undefined, 1024)).toString(),
        await ctx.fs.readText(target),
    );
    assert.equal(
        Buffer.from(
            await ctx.fs.readByteRange(target, { offset: 7, length: 6 }),
        ).toString(),
        'marker',
    );
    await denied(() => ctx.fs.readBytes(target, undefined, 2), 'FS_TOO_LARGE');
    assert.equal((await ctx.fs.lstat('fs-proof.txt')).type, 'file');
    const edit = { oldString: 'alpha', newString: 'beta', replaceAll: false };
    await denied(
        () => ctx.fs.editText(target, edit, undefined, undefined, policy),
        'FS_AMBIGUOUS_EDIT',
    );
    await denied(
        () =>
            ctx.fs.editText(
                target,
                { ...edit, oldString: 'absent' },
                undefined,
                undefined,
                policy,
            ),
        'FS_EDIT_NOT_FOUND',
    );
    await denied(
        () => ctx.fs.editText(target, edit, undefined, undefined, readOnly),
        'FS_SANDBOX_DENIED',
    );
    const updated = await ctx.fs.editText(
        target,
        { ...edit, replaceAll: true },
        { version: write.version },
        undefined,
        policy,
    );
    assert.match(updated.after, /beta beta/);
    await denied(
        () =>
            ctx.fs.writeText(
                target,
                'stale',
                { kind: 'replaceIfVersion', version: write.version },
                undefined,
                policy,
            ),
        'FS_STALE_VERSION',
    );
    const race = await Promise.allSettled([
        ctx.fs.writeText(
            target,
            'winner one\n',
            { kind: 'replaceIfVersion', version: updated.version },
            undefined,
            policy,
        ),
        ctx.fs.writeText(
            target,
            'winner two\n',
            { kind: 'replaceIfVersion', version: updated.version },
            undefined,
            policy,
        ),
    ]);
    assert.equal(race.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(
        race.find((x) => x.status === 'rejected').reason.code,
        'FS_STALE_VERSION',
    );
    const before = await ctx.fs.readText(target);
    await denied(
        () =>
            ctx.fs.editText(
                target,
                {
                    oldString: 'winner',
                    newString: 'x'.repeat(1024 * 1024),
                    replaceAll: true,
                },
                undefined,
                undefined,
                policy,
            ),
        'FS_TOO_LARGE',
    );
    assert.equal(await ctx.fs.readText(target), before);
    const run = async (argv) => {
        const h = ctx.subprocess.spawn({
            argv,
            cwd: workspaceRoot,
            stdio: {
                stdin: 'ignore',
                stdout: { maxBytes: 65536 },
                stderr: { maxBytes: 65536 },
            },
            graceMs: 100,
        });
        assert.equal(
            (await h.done).exitCode,
            0,
            h.collected.stderr.readFrom(0).text,
        );
        return h.collected.stdout.readFrom(0).text;
    };
    assert.equal(
        await run([
            '/usr/local/bin/node',
            '-e',
            "process.stdout.write(require('node:fs').readFileSync('fs-proof.txt'))",
        ]),
        before,
    );
    await run([
        '/usr/local/bin/node',
        '-e',
        "const fs=require('node:fs');fs.symlinkSync('fs-proof.txt','fs-alias');fs.writeFileSync('/sandbox/outside-fs','outside');fs.symlinkSync('/sandbox/outside-fs','fs-outside');fs.writeFileSync('process-proof.txt','from process');fs.writeFileSync('binary-proof',Buffer.from([0,1,2]));fs.writeFileSync('large-proof','你好'.repeat(200000));",
    ]);
    assert.equal(
        (await ctx.fs.resolve('fs-alias')).targetKey,
        target.targetKey,
    );
    assert.equal((await ctx.fs.lstat('fs-alias')).type, 'symlink');
    assert.equal(
        await ctx.fs.readText(await ctx.fs.resolve('process-proof.txt')),
        'from process',
    );
    await run([
        '/usr/local/bin/node',
        '-e',
        "require('node:fs').mkdirSync('bound')",
    ]);
    await apply(nested, {
        ...config,
        workspaceRoot: workspaceRoot + '/bound',
        defaultMode: 'workspace-write',
        requireFullEnforcement: false,
    });
    const nestedTarget = await nested.fs.resolve('nested-proof');
    await nested.fs.writeText(nestedTarget, 'nested');
    assert.equal(
        nested.fs.processPath(nestedTarget),
        workspaceRoot + '/bound/nested-proof',
    );
    await assert.rejects(
        nested.sandbox.confine(['/bin/true'], policy),
        /outside bound workspace/,
    );
    const nestedPolicy = {
        mode: 'workspace-write',
        workspaceRoot: nested.openShellWorkspace.root,
    };
    const wrapped = await nested.sandbox.confine(
        ['/bin/sh', '-c', 'printf wrapped > nested-proof'],
        nestedPolicy,
    );
    const nestedProcess = nested.subprocess.spawn({
        argv: wrapped.argv,
        cwd: nested.openShellWorkspace.root,
        stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 4096 },
            stderr: { maxBytes: 4096 },
        },
        graceMs: 100,
    });
    assert.equal((await nestedProcess.done).exitCode, 0);
    assert.equal(await nested.fs.readText(nestedTarget), 'wrapped');
    const temp = await ctx.fs.resolve('/tmp/fs-temporary');
    await ctx.fs.writeText(temp, 'temporary', undefined, undefined, policy);
    await denied(
        () => ctx.fs.writeText(temp, 'blocked', undefined, undefined, readOnly),
        'FS_SANDBOX_DENIED',
    );
    const directory = await ctx.fs.resolve('.');
    assert.equal(ctx.fs.contains(directory, target), true);
    assert.match(ctx.fs.fileUrl(target), /^file:\/\/\/sandbox\/project\//);
    assert(
        (await ctx.fs.listDir(directory)).some(
            (e) =>
                e.name === 'fs-proof.txt' &&
                e.target.targetKey === target.targetKey,
        ),
    );
    assert.throws(
        () => other.fs.processPath(target),
        /another execution world/,
    );
    await assert.rejects(
        () => ctx.fs.writeText(awaitable(), 'no'),
        /another execution world/,
    );
    function awaitable() {
        return { targetKey: 'forged', displayPath: '/etc/passwd' };
    }
    await denied(
        async () =>
            ctx.fs.writeText(
                await ctx.fs.resolve('fs-outside'),
                'blocked',
                undefined,
                undefined,
                policy,
            ),
        'FS_SANDBOX_DENIED',
    );
    await denied(
        async () =>
            other.fs.writeText(
                await other.fs.resolve('/opt/dsh-permission-outer/fs-proof'),
                'blocked',
                undefined,
                undefined,
                { mode: 'danger-full-access', workspaceRoot },
            ),
        'FS_PERMISSION_DENIED',
    );
    await denied(
        async () => ctx.fs.readText(await ctx.fs.resolve('binary-proof')),
        'FS_NOT_TEXT',
    );
    await denied(
        async () => ctx.fs.readText(await ctx.fs.resolve('large-proof')),
        'FS_TOO_LARGE',
    );
    let streamed = '';
    for await (const chunk of await ctx.fs.streamText(
        await ctx.fs.resolve('large-proof'),
    ))
        streamed += chunk;
    assert.equal(streamed, '你好'.repeat(200000));
    await denied(
        () => ctx.fs.readText(target, globalThis.AbortSignal.abort()),
        'FS_ABORTED',
    );
    // Use the real DSH working-directory owner with minimal Agent-facing services.
    // Session storage/model execution are deliberately outside this seam test.
    const states = new Map();
    ctx.reflect.provide('sessionProjections', {
        register(unit) {
            states.set(unit.key, unit);
        },
        stateOf(session, key) {
            const unit = states.get(key);
            return (session.events ?? []).reduce(
                (state, event) => unit.apply(state, event),
                unit.init(session.header),
            );
        },
    });
    ctx.reflect.provide('systemPrompt', {
        context() {},
        getContextOrder() {
            return 0;
        },
    });
    // The plugin installs WorkingDirectoryService after both dependencies appear.
    await new Promise((resolve) => globalThis.setTimeout(resolve, 30));
    assert(ctx.workingDirectory instanceof WorkingDirectoryService);
    const notices = [];
    const agent = {
        ctx,
        inject(notice) {
            notices.push(notice);
        },
        session: {
            header: { cwd: workspaceRoot },
            id: 'fs-session',
            events: [],
            append(type, data) {
                this.events.push({ type, data });
            },
        },
    };
    await assert.rejects(
        ctx.workingDirectory.ensure({
            ...agent,
            session: { ...agent.session, header: { cwd: '/tmp' } },
        }),
        /outside bound OpenShell workspace/,
    );
    assert.equal(
        await ctx.workingDirectory.set(agent, 'bound'),
        workspaceRoot + '/bound',
    );
    assert.equal(
        await ctx.workingDirectory.ensure(agent),
        workspaceRoot + '/bound',
    );
    assert.equal(
        ctx.workingDirectory.get(agent.session),
        workspaceRoot + '/bound',
    );
    assert.equal(await ctx.workingDirectory.set(agent, '..'), workspaceRoot);
    const eventsBefore = agent.session.events.length;
    await assert.rejects(
        ctx.workingDirectory.set(agent, '/tmp'),
        /outside bound OpenShell workspace/,
    );
    await assert.rejects(
        ctx.workingDirectory.set(agent, 'fs-outside'),
        /outside bound OpenShell workspace/,
    );
    await assert.rejects(
        ctx.workingDirectory.set(agent, 'missing-directory'),
        /directory does not exist/,
    );
    await assert.rejects(
        ctx.workingDirectory.set(agent, ''),
        /cd must not be empty/,
    );
    assert.equal(agent.session.events.length, eventsBefore);
    assert.equal(notices.length, 2);
    assert.equal(await ctx.workingDirectory.ensure(agent), workspaceRoot);
    const exec = { agent, signal: new globalThis.AbortController().signal };
    const grep = await runRipgrep(
        ctx,
        exec,
        'grep',
        buildGrepCommand(
            parseGrepArgs({ pattern: 'winner', path: 'fs-proof.txt' }),
        ),
        65536,
        100,
        4096,
    );
    assert.equal(grep.workdir, workspaceRoot);
    assert.equal(parseGrepMatches(grep.stdout).length, 1);
    const glob = await runRipgrep(
        ctx,
        exec,
        'glob',
        buildGlobCommand(parseGlobArgs({ pattern: '*proof.txt' })),
        65536,
        100,
        4096,
    );
    assert.match(glob.stdout, /fs-proof.txt/);
    const empty = await runRipgrep(
        ctx,
        exec,
        'grep',
        buildGrepCommand(
            parseGrepArgs({ pattern: 'does-not-exist', path: 'fs-proof.txt' }),
        ),
        65536,
        100,
        4096,
    );
    assert.equal(empty.noMatches, true);
    console.log(
        'PASS: RC filesystem read/write/edit/stream/range/list, stale/concurrent guards, symlink and outer policy denial, shared remote workspace/process, DSH working-directory and grep/glob',
    );
} finally {
    await nested.fiber.dispose();
    await other.fiber.dispose();
    await ctx.fiber.dispose();
}
