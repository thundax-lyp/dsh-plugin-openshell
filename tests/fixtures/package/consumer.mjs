import process from 'node:process';
import console from 'node:console';

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { posix, dirname, join } from 'node:path';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import {
    apply,
    OpenShellFileSystem,
    OpenShellSubprocessRuntime,
    OpenShellWorkspace,
} from 'dsh-sandbox-openshell';
const metadata = JSON.parse(
    await readFile(
        fileURLToPath(
            import.meta.resolve('dsh-sandbox-openshell/package.json'),
        ),
    ),
);
assert.equal(metadata.version, process.argv[2]);
const runtime = dirname(
    fileURLToPath(import.meta.resolve('dsh-sandbox-openshell/runtime/fs.mjs')),
);
await access(join(runtime, 'confine.mjs'));
const runtimePackage = JSON.parse(
    await readFile(join(runtime, 'package.json')),
);
assert.equal(
    runtimePackage.dependencies['@deepseek-ai/dsh-sandbox-local'],
    '0.2.1-rc.4',
);
const calls = [],
    contents = new Map(),
    root = '/sandbox/project';
const client = {
    async execInteractive(name, argv, options) {
        const chunks = [];
        let eof;
        const closed = new Promise((resolve) => {
            eof = resolve;
        });
        calls.push({ name, options });
        return {
            write(data) {
                chunks.push(data);
            },
            closeInput() {
                eof();
            },
            cancel() {},
            done: closed.then(() => 0),
            output: (async function* () {
                await closed;
                let output;
                if (argv[1]?.endsWith('/fs.mjs')) {
                    const r = JSON.parse(Buffer.concat(chunks));
                    const path = posix.resolve(r.cwd ?? root, r.path);
                    let value;
                    if (r.method === 'resolve')
                        value = { targetKey: path, displayPath: path };
                    else if (r.method === 'writeText') {
                        contents.set(path, r.content);
                        value = {
                            operation: 'create',
                            version: 'v1',
                            before: null,
                            after: r.content,
                        };
                    } else if (r.method === 'readText')
                        value = contents.get(path);
                    else throw new Error('Unexpected filesystem operation');
                    output = JSON.stringify({ version: '0.2.1-rc.4', value });
                } else if (argv[1]?.endsWith('/confine.mjs')) {
                    const r = JSON.parse(Buffer.from(argv[2], 'base64'));
                    output = JSON.stringify({
                        version: '0.2.1-rc.4',
                        argv: r.argv,
                        enforcement: 'partial',
                        denialSignatures: [],
                        runnerFailureRules: [],
                    });
                } else output = 'consumer process\n';
                yield { stream: 'stdout', data: Buffer.from(output) };
            })(),
        };
    },
};
const ctx = new Context();
try {
    await apply(ctx, {
        interactiveClient: client,
        sandbox: 'package-test',
        helper: '/opt/dsh-runtime/confine.mjs',
        workspaceRoot: root,
    });
    assert(ctx.fs instanceof OpenShellFileSystem);
    assert(ctx.subprocess instanceof OpenShellSubprocessRuntime);
    assert(ctx.openShellWorkspace instanceof OpenShellWorkspace);
    const target = await ctx.fs.resolve('file.txt');
    assert.equal(ctx.fs.processPath(target), root + '/file.txt');
    await ctx.fs.writeText(target, 'package 中文', undefined, undefined, {
        mode: 'workspace-write',
        workspaceRoot: root,
    });
    assert.equal(await ctx.fs.readText(target), 'package 中文');
    const handle = ctx.subprocess.spawn({
        argv: ['/bin/echo', 'consumer'],
        cwd: root,
        stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 4096 },
            stderr: { maxBytes: 4096 },
        },
        graceMs: 100,
    });
    assert.equal((await handle.done).exitCode, 0);
    assert.equal(
        handle.collected.stdout.readFrom(0).text,
        'consumer process\n',
    );
    await assert.rejects(
        ctx.sandbox.confine(['/bin/true'], {
            mode: 'read-only',
            workspaceRoot: root,
        }),
        /full confinement required/,
    );
    assert.throws(() => ctx.subprocess.terminalEnvironment(), /PTY/);
    assert(
        calls.every(
            (call) =>
                call.name === 'package-test' &&
                call.options.workdir === root &&
                call.options.timeoutSecs === 0,
        ),
    );
} finally {
    await ctx.fiber.dispose();
}
console.log(
    'PASS: installed tarball exports, runtime helpers, shared fs/process/workspace, strict partial rejection and unsupported PTY',
);
