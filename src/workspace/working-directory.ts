import { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory';

/** Preserve DSH's session directory machinery, while keeping its paths remote. */
export class OpenShellWorkingDirectory extends WorkingDirectoryService {
    private async boundDirectory(
        path: string,
        cwd: string,
        signal?: AbortSignal,
    ) {
        const root = await this.ctx.fs.resolve(
            this.ctx.openShellWorkspace.root,
            { ...(signal ? { signal } : {}) },
        );
        const target = await this.ctx.fs.resolve(path, {
            cwd,
            ...(signal ? { signal } : {}),
        });
        if (!this.ctx.fs.contains(root, target))
            throw new Error(
                'working directory outside bound OpenShell workspace',
            );
        return this.ctx.fs.processPath(target);
    }
    override async ensure(
        agent: Parameters<WorkingDirectoryService['ensure']>[0],
        signal?: AbortSignal,
    ) {
        const directory = await super.ensure(agent, signal);
        return this.boundDirectory(
            directory,
            this.ctx.openShellWorkspace.root,
            signal,
        );
    }
    override async set(
        agent: Parameters<WorkingDirectoryService['set']>[0],
        path: string,
        signal?: AbortSignal,
    ) {
        if (path.length === 0) return super.set(agent, path, signal);
        const directory = await this.boundDirectory(
            path,
            this.get(agent.session),
            signal,
        );
        return super.set(agent, directory, signal);
    }
}
