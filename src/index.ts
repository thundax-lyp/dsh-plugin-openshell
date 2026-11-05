import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './connection.ts';
import { OpenShellSubprocessRuntime } from './subprocess/provider.ts';
import { OpenShellSandboxProvider } from './sandbox/provider.ts';
import { OpenShellFileSystem } from './fs/provider.ts';
import { OpenShellWorkspace } from './workspace/binding.ts';
import { OpenShellWorkingDirectory } from './workspace/working-directory.ts';
export { OpenShellFileSystem, OpenShellWorkspace, OpenShellWorkingDirectory };
export { OpenShellConnection } from './connection.ts';
export type { Config } from './connection.ts';
export { OpenShellSubprocessRuntime } from './subprocess/provider.ts';
export { OpenShellSandboxProvider } from './sandbox/provider.ts';
export { requireFullConfinement } from './sandbox/confinement.ts';
export async function apply(ctx: Context, config: Config) {
    await ctx.plugin(OpenShellSubprocessRuntime, config);
    await ctx.plugin(OpenShellWorkspace);
    await ctx.plugin(OpenShellFileSystem);
    await ctx.plugin(OpenShellSandboxProvider);
    ctx.inject(['sessionProjections', 'systemPrompt'], async (scope) => {
        if (scope.get('workingDirectory'))
            throw new Error(
                'install OpenShell before the working-directory provider',
            );
        await scope.plugin(OpenShellWorkingDirectory, {
            defaultDirectory: ctx.openShellWorkspace.root,
        });
    });
}

export type {
    OfficialSandboxClient,
    OfficialExecSession,
} from './subprocess/interactive.ts';
