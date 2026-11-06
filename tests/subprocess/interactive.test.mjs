import assert from 'node:assert/strict';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { Context } from '@deepseek-ai/cordis';
import { apply } from '../../src/index.ts';
let failFinal = false;
const writes = [];
const calls = [];
const client = {
    async execInteractive(name, argv, options) {
        calls.push({ name, argv, options });
        let resolveInput;
        const inputReady = new Promise((resolve) => {
            resolveInput = resolve;
        });
        let bytes = Buffer.alloc(0);
        let finish;
        const done = new Promise((resolve, reject) => {
            finish = () =>
                failFinal ? reject(new Error('final RPC failure')) : resolve(7);
        });
        void done.catch(() => {});
        return {
            write(data) {
                assert(data.length <= 65536, 'stdin message exceeds 64 KiB');
                writes.push(Buffer.from(data));
                bytes = Buffer.concat([bytes, data]);
            },
            closeInput() {
                resolveInput();
            },
            cancel() {},
            done,
            output: (async function* () {
                await inputReady;
                yield { stream: 'stdout', data: bytes };
                yield { stream: 'stderr', data: Buffer.from('error-output') };
                yield { type: 'exit', exitCode: 7 };
                finish();
            })(),
        };
    },
};
const ctx = new Context();
try {
    await apply(ctx, {
        interactiveClient: client,
        sandbox: 'selected-box',
        helper: '/helper/confine.mjs',
        executionTimeoutSeconds: 3,
    });
    const spec = {
        argv: ['/bin/echo', 'literal $()'],
        cwd: '/sandbox/project',
        stdio: {
            stdin: { data: 'input' },
            stdout: { maxBytes: 100 },
            stderr: { maxBytes: 100 },
        },
        graceMs: 100,
    };
    const h = ctx.subprocess.spawn(spec);
    assert.equal((await h.done).exitCode, 7);
    assert.equal(h.collected.stdout.readFrom(0).text, 'input');
    assert.equal(h.collected.stderr.readFrom(0).text, 'error-output');
    assert.equal(calls[0].name, 'selected-box');
    assert.deepEqual(calls[0].argv, spec.argv);
    assert.equal(calls[0].options.workdir, spec.cwd);
    assert.equal(calls[0].options.tty, false);
    assert.equal(calls[0].options.timeoutSecs, 0);
    assert.equal(calls[0].options.noLoginShell, true);
    await assert.rejects(h.waitForExit(), /remote exit unconfirmed/);
    assert.equal(await h.waitForExit(globalThis.AbortSignal.abort()), false);
    failFinal = true;
    await assert.rejects(ctx.subprocess.spawn(spec).done, /final RPC failure/);
    assert.throws(
        () =>
            ctx.subprocess.spawn({
                ...spec,
                signal: globalThis.AbortSignal.abort(),
            }),
        /abort/i,
    );
    assert.equal(calls.length, 2);
    failFinal = false;
    const payload = '远端 stdin 🚀\n'.repeat(90000);
    const input = Buffer.from(payload);
    assert(input.length > 1024 * 1024);
    for (const piped of [false, true]) {
        writes.length = 0;
        const large = ctx.subprocess.spawn({
            ...spec,
            stdio: {
                stdin: piped ? 'pipe' : { data: payload },
                stdout: { maxBytes: input.length + 100 },
                stderr: { maxBytes: 100 },
            },
        });
        if (piped) large.stdin.end(input);
        assert.equal((await large.done).exitCode, 7);
        assert.equal(large.collected.stdout.readFrom(0).text, payload);
        assert(writes.length > 1);
        assert.deepEqual(Buffer.concat(writes), input);
    }
    console.log(
        'PASS: official interactive client binding, stdin/output including >1 MiB fixed and piped input, disabled server timeout, final RPC failure and pre-cancel',
    );
} finally {
    await ctx.fiber.dispose();
}
