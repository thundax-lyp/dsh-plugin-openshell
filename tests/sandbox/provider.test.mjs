import console from 'node:console';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import {
    apply,
    OpenShellConnection,
    OpenShellSandboxProvider,
} from '../../src/index.ts';
import { sandboxClient } from '../fixtures/sandbox/client.mjs';
const { client, state } = sandboxClient();
const config = {
    interactiveClient: client,
    sandbox: 'box-a',
    helper: '/fixture/confine.mjs',
};
const ctx = new Context();
const wrong = new Context();
try {
    await apply(ctx, config);
    const policy = { mode: 'read-only', workspaceRoot: '/sandbox/project' };
    const argv = ['/bin/sh', '-c', '字面参数 $(no-command); test'];
    const wrapped = await ctx.sandbox.confine(argv, policy);
    assert.deepEqual(wrapped.argv, argv);
    assert.equal(state.calls[0].name, 'box-a');
    assert.deepEqual(state.calls[0].request, { argv, policy });
    assert.equal(state.calls[0].options.workdir, policy.workspaceRoot);
    assert.equal(state.calls[0].options.timeoutSecs, 0);
    state.response = { enforcement: 'partial' };
    await assert.rejects(
        ctx.sandbox.confine(argv, policy),
        /full confinement required/,
    );
    state.response = { version: '0.2.2-alpha.2' };
    await assert.rejects(
        ctx.sandbox.confine(argv, policy),
        /version-mismatched/,
    );
    state.response = {};
    const before = state.calls.length;
    await assert.rejects(
        ctx.sandbox.confine(argv, policy, globalThis.AbortSignal.abort()),
        /abort/i,
    );
    assert.equal(state.calls.length, before);
    assert.throws(
        () =>
            new OpenShellConnection({
                ...config,
                interactiveClient: undefined,
            }),
        /official SDK/,
    );
    assert.throws(
        () => new OpenShellConnection({ ...config, sandbox: '-forged' }),
        /sandbox name/,
    );
    assert.throws(
        () =>
            new OpenShellConnection({ ...config, executionTimeoutSeconds: 0 }),
        /timeout/,
    );
    class WrongRuntime extends SubprocessRuntime {}
    await wrong.plugin(WrongRuntime);
    await wrong.plugin(OpenShellSandboxProvider);
    await assert.rejects(
        wrong.sandbox.confine(argv, policy),
        /matching OpenShell subprocess/,
    );
    console.log(
        'PASS: SDK-only confinement, literal UTF-8 argv, fixed target/cwd, partial rejection, RC version and provider matching',
    );
} finally {
    await wrong.fiber.dispose();
    await ctx.fiber.dispose();
}
