import { spawnInteractive } from './interactive.ts';
import { Context } from '@deepseek-ai/cordis';
import {
    SubprocessRuntime,
    SubprocessExecutableNotFoundError,
} from '@deepseek-ai/dsh-subprocess';
import type {
    SubprocessSpawnSpec,
    SubprocessHandle,
    SubprocessTerminalHandle,
    SubprocessTerminalEnvironment,
} from '@deepseek-ai/dsh-subprocess';
import { OpenShellConnection, type Config } from '../connection.ts';

/** Ordinary subprocesses only. Uses official SDK interactive exec. */
export class OpenShellSubprocessRuntime extends SubprocessRuntime {
    private interactive = new Set<ReturnType<typeof spawnInteractive>>();
    readonly connection: OpenShellConnection;
    constructor(ctx: Context, config: Config) {
        super(ctx);
        this.connection = new OpenShellConnection(config);
        ctx.effect(
            () => async () => {
                for (const handle of this.interactive) handle.terminate();
                await Promise.all(
                    [...this.interactive].map((h) => h.transportClosed),
                );
            },
            'OpenShell SDK transport teardown',
        );
    }
    async resolveExecutable(
        command: string,
        env?: Readonly<Record<string, string>>,
        signal?: AbortSignal,
    ): Promise<string> {
        if (env && Object.keys(env).length)
            throw new Error('executable lookup env overrides unsupported');
        if (
            /[\0\r\n]/.test(command) ||
            command.startsWith('-') ||
            !command ||
            (!command.startsWith('/') && command.includes('/'))
        )
            throw new Error('absolute executable or bare name required');
        const probe = `const fs=require('node:fs'),p=require('node:path');const name=process.argv[1];for(const candidate of(name.startsWith('/')?[name]:(process.env.PATH||'').split(p.delimiter).map(d=>p.join(d,name)))){try{fs.accessSync(candidate,fs.constants.X_OK);if(fs.statSync(candidate).isFile()){process.stdout.write(fs.realpathSync(candidate));process.exit(0)}}catch{}}process.exit(127);`;
        try {
            return await this.connection.capture(
                [
                    this.connection.config.node ?? '/usr/local/bin/node',
                    '-e',
                    probe,
                    command,
                ],
                this.connection.config.workspaceRoot!,
                signal,
            );
        } catch (error) {
            if (
                error instanceof Error &&
                (error.cause as { code?: unknown } | undefined)?.code === 127
            )
                throw new SubprocessExecutableNotFoundError(
                    'Executable not found in OpenShell sandbox: ' + command,
                    { cause: error },
                );
            throw error;
        }
    }

    terminalEnvironment(): Promise<SubprocessTerminalEnvironment> {
        throw new Error('OpenShell PTY is outside this provider scope');
    }
    spawnTerminal(): Promise<SubprocessTerminalHandle> {
        throw new Error('OpenShell PTY is outside this provider scope');
    }
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
        if (spec.stdio.control !== undefined)
            throw new Error('OpenShell control fd unsupported');
        if (spec.env && Object.keys(spec.env).length)
            throw new Error('remote environment overrides unsupported');
        spec.signal?.throwIfAborted();
        const mapping = this.connection.config.searchExecutable;
        const argv =
            mapping && spec.argv[0] === mapping.host
                ? [mapping.remote, ...spec.argv.slice(1)]
                : spec.argv;
        const handle = spawnInteractive(this.connection, { ...spec, argv });
        this.interactive.add(handle);
        void handle.transportClosed.then(() => this.interactive.delete(handle));
        return handle;
    }
}
