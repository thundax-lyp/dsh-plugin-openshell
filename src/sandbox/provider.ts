import { inside } from '../workspace/binding.ts';
import { posix } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import {
    SandboxProvider,
    SandboxUnavailableError,
    type SandboxPolicy,
} from '@deepseek-ai/dsh-sandbox';
import { OpenShellSubprocessRuntime } from '../subprocess/provider.ts';
import { requireFullConfinement } from './confinement.ts';

/** Same-sandbox wrapper, shaped like the official SshSandboxProvider seam. */
export class OpenShellSandboxProvider extends SandboxProvider {
    static inject = ['subprocess'];
    constructor(ctx: Context) {
        super(ctx);
    }
    async confine(
        argv: readonly string[],
        policy: SandboxPolicy,
        signal?: AbortSignal,
    ) {
        try {
            const runtime = this.ctx.subprocess;
            if (!(runtime instanceof OpenShellSubprocessRuntime))
                throw new Error(
                    'matching OpenShell subprocess provider required',
                );
            if (
                !posix.isAbsolute(policy.workspaceRoot) ||
                !inside(
                    runtime.connection.config.workspaceRoot!,
                    policy.workspaceRoot,
                )
            )
                throw new Error('policy root outside bound workspace');
            const wrapped = await runtime.connection.confine(
                argv,
                policy,
                signal,
            );
            if (runtime.connection.config.requireFullEnforcement !== false)
                requireFullConfinement(wrapped);
            return wrapped;
        } catch (error) {
            signal?.throwIfAborted();
            throw new SandboxUnavailableError(
                policy.mode,
                error instanceof Error ? error.message : String(error),
            );
        }
    }
}
