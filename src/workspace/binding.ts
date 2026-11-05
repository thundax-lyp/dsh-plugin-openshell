import { posix } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import { OpenShellSubprocessRuntime } from '../subprocess/provider.ts';

/** Fixed execution-world binding; session persistence remains DSH's responsibility. */
export class OpenShellWorkspace extends Service {
    static inject = ['subprocess'];
    readonly root: string;
    readonly sandbox: string;
    constructor(ctx: Context) {
        super(ctx, 'openShellWorkspace');
        if (!(ctx.subprocess instanceof OpenShellSubprocessRuntime))
            throw new Error('matching OpenShell subprocess provider required');
        this.root = ctx.subprocess.connection.config.workspaceRoot!;
        this.sandbox = ctx.subprocess.connection.config.sandbox;
    }
}

export function inside(root: string, path: string) {
    const relative = posix.relative(root, path);
    return (
        relative === '' ||
        (relative !== '..' &&
            !relative.startsWith('../') &&
            !posix.isAbsolute(relative))
    );
}

declare module '@deepseek-ai/cordis' {
    interface Context {
        openShellWorkspace: OpenShellWorkspace;
    }
}
