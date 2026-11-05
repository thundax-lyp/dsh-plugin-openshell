import { posix } from 'node:path';
import type { OfficialSandboxClient } from './subprocess/interactive.ts';
import type { SandboxPolicy, ConfinedArgv } from '@deepseek-ai/dsh-sandbox';

/** Trusted deployment configuration; never populated from model/tool arguments. */
export interface Config {
    interactiveClient: OfficialSandboxClient;
    sandbox: string;
    helper: string;
    /** Absolute path inside the sandbox, never a harness-host path. */
    workspaceRoot?: string;
    /** Defaults to read-only; explicit per-call policies may override it. */
    defaultMode?: 'read-only' | 'workspace-write';
    /** Defaults to fs.mjs beside the confinement helper. */
    fileSystemHelper?: string;
    /** Explicit remote replacement for the DSH packaged ripgrep executable. */
    searchExecutable?: { host: string; remote: string };
    node?: string;
    /** Client-side deadline for ordinary executions, in seconds. */
    executionTimeoutSeconds?: number;
    /** Default true; false is for explicit best-effort consumers and diagnostics. */
    requireFullEnforcement?: boolean;
}

export class OpenShellConnection {
    readonly config: Readonly<Config>;
    constructor(config: Config) {
        for (const value of [
            config.helper,
            config.node ?? '/usr/local/bin/node',
            config.workspaceRoot ?? '/sandbox/project',
            config.fileSystemHelper ??
                posix.join(posix.dirname(config.helper), 'fs.mjs'),
        ])
            if (!value.startsWith('/') || /[\0\r\n]/.test(value))
                throw new Error('absolute deployment paths required');
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(config.sandbox))
            throw new Error('explicit sandbox name required');
        if (
            !config.interactiveClient ||
            typeof config.interactiveClient.execInteractive !== 'function'
        )
            throw new Error('official SDK execInteractive client required');
        if (
            config.defaultMode !== undefined &&
            !['read-only', 'workspace-write'].includes(config.defaultMode)
        )
            throw new Error('invalid default sandbox mode');
        if (
            config.searchExecutable &&
            [config.searchExecutable.host, config.searchExecutable.remote].some(
                (p) => !p.startsWith('/') || /[\0\r\n]/.test(p),
            )
        )
            throw new Error('absolute search executable paths required');
        const timeout = config.executionTimeoutSeconds ?? 60;
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600)
            throw new Error('execution timeout must be 1..3600 seconds');
        this.config = Object.freeze({
            ...config,
            ...(config.searchExecutable
                ? {
                      searchExecutable: Object.freeze({
                          ...config.searchExecutable,
                      }),
                  }
                : {}),
            executionTimeoutSeconds: timeout,
            workspaceRoot: posix.normalize(
                config.workspaceRoot ?? '/sandbox/project',
            ),
            defaultMode: config.defaultMode ?? 'read-only',
            fileSystemHelper:
                config.fileSystemHelper ??
                posix.join(posix.dirname(config.helper), 'fs.mjs'),
        });
    }

    async capture(
        argv: readonly string[],
        cwd: string,
        signal?: AbortSignal,
        input?: Buffer,
        maxOutputBytes = 1024 * 1024,
    ): Promise<string> {
        signal?.throwIfAborted();
        if (
            !cwd.startsWith('/') ||
            cwd.includes('\0') ||
            !argv[0] ||
            argv.some((part) => part.includes('\0'))
        )
            throw new Error('invalid remote argv or cwd');
        const combined = AbortSignal.any([
            AbortSignal.timeout(15000),
            ...(signal ? [signal] : []),
        ]);
        const session = await this.config.interactiveClient.execInteractive(
            this.config.sandbox,
            [...argv],
            {
                tty: false,
                noLoginShell: true,
                workdir: cwd,
                timeoutSecs: 0,
                signal: combined,
            },
        );
        const stdout: Buffer[] = [],
            stderr: Buffer[] = [];
        let bytes = 0;
        try {
            if (input)
                for (let offset = 0; offset < input.length; offset += 65536)
                    session.write(input.subarray(offset, offset + 65536));
            session.closeInput();
            const pump = (async () => {
                for await (const event of session.output)
                    if ('stream' in event) {
                        bytes += event.data.length;
                        if (bytes > maxOutputBytes)
                            throw new Error(
                                'OpenShell helper response exceeds buffer limit',
                            );
                        if (event.stream === 'stdout') stdout.push(event.data);
                        else stderr.push(event.data);
                    }
            })();
            const [, code] = await Promise.all([pump, session.done]);
            if (code !== 0)
                throw new Error(
                    'OpenShell execution failed: ' +
                        Buffer.concat(stderr).toString(),
                    {
                        cause: Object.assign(
                            new Error('remote command failed'),
                            { code },
                        ),
                    },
                );
            return Buffer.concat(stdout).toString();
        } finally {
            session.cancel();
        }
    }

    async confine(
        argv: readonly string[],
        policy: SandboxPolicy,
        signal?: AbortSignal,
    ): Promise<ConfinedArgv> {
        if (Buffer.byteLength(JSON.stringify({ argv, policy })) > 65536)
            throw new Error('confinement request too large');
        const request = Buffer.from(JSON.stringify({ argv, policy })).toString(
            'base64',
        );
        const output = await this.capture(
            [
                this.config.node ?? '/usr/local/bin/node',
                this.config.helper,
                request,
            ],
            policy.workspaceRoot,
            signal,
        );
        signal?.throwIfAborted();
        const value: unknown = JSON.parse(output);
        if (!value || typeof value !== 'object')
            throw new Error('invalid confinement response');
        const result = value as ConfinedArgv & { version?: string };
        if (
            result.version !== '0.2.1-rc.4' ||
            !Array.isArray(result.argv) ||
            result.argv.length === 0 ||
            !result.argv.every(
                (part) => typeof part === 'string' && !part.includes('\0'),
            ) ||
            !['full', 'partial'].includes(result.enforcement) ||
            !Array.isArray(result.denialSignatures) ||
            !result.denialSignatures.every((v) => typeof v === 'string') ||
            !Array.isArray(result.runnerFailureRules) ||
            !result.runnerFailureRules.every(
                (r) =>
                    r &&
                    Array.isArray(r.fatalSignatures) &&
                    r.fatalSignatures.every(
                        (v: unknown) => typeof v === 'string',
                    ) &&
                    (r.allowedExitCodes === undefined ||
                        (Array.isArray(r.allowedExitCodes) &&
                            r.allowedExitCodes.every(Number.isInteger))) &&
                    (r.informationalLines === undefined ||
                        (Array.isArray(r.informationalLines) &&
                            r.informationalLines.every(
                                (v: unknown) => typeof v === 'string',
                            ))),
            )
        )
            throw new Error(
                'invalid or version-mismatched confinement response',
            );
        return {
            argv: result.argv,
            enforcement: result.enforcement,
            denialSignatures: result.denialSignatures,
            runnerFailureRules: result.runnerFailureRules,
        };
    }
}
