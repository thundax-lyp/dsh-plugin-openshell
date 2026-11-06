import { PassThrough, Writable } from 'node:stream';
import { once } from 'node:events';
import process from 'node:process';
import type {
    SubprocessHandle,
    SubprocessSpawnSpec,
    SubprocessOutputMode,
} from '@deepseek-ai/dsh-subprocess';
import {
    OutputCollector,
    prepareManagedProcessBinding,
} from '@deepseek-ai/dsh-subprocess-local/output';
import type { OpenShellConnection } from '../connection.ts';

export interface OfficialExecSession {
    output: AsyncIterable<
        | { stream: 'stdout' | 'stderr'; data: Buffer }
        | { type: 'exit'; exitCode: number }
    >;
    write(data: Buffer): void;
    closeInput(): void;
    cancel(): void;
    done: Promise<number>;
}
/** Structural seam for the official SandboxClient, avoiding a vendored SDK/auth stack. */
export interface OfficialSandboxClient {
    execInteractive(
        name: string,
        command: string[],
        options: {
            tty: boolean;
            noLoginShell: boolean;
            workdir: string;
            timeoutSecs: number;
            signal: AbortSignal;
        },
    ): Promise<OfficialExecSession>;
}

export function spawnInteractive(
    connection: OpenShellConnection,
    spec: SubprocessSpawnSpec,
): SubprocessHandle & { transportClosed: Promise<void> } {
    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0)
        throw new Error('positive graceMs required');
    if (
        !spec.argv[0] ||
        spec.argv.some((v) => v.includes('\0')) ||
        !spec.cwd.startsWith('/') ||
        spec.cwd.includes('\0')
    )
        throw new Error('invalid remote argv or cwd');
    for (const mode of [spec.stdio.stdout, spec.stdio.stderr])
        if (
            typeof mode === 'object' &&
            (!Number.isInteger(mode.maxBytes) ||
                mode.maxBytes < 1 ||
                (mode.spill &&
                    (!Number.isInteger(mode.spill.maxBytes) ||
                        mode.spill.maxBytes < 1)))
        )
            throw new Error('invalid collection limit');
    const control = new AbortController();
    const signal = AbortSignal.any([
        control.signal,
        AbortSignal.timeout(connection.config.executionTimeoutSeconds! * 1000),
        ...(spec.signal ? [spec.signal] : []),
    ]);
    const binding = prepareManagedProcessBinding();
    const output = (mode: SubprocessOutputMode, label: 'stdout' | 'stderr') => {
        const pipe = mode === 'pipe' ? new PassThrough() : undefined;
        const collector =
            typeof mode === 'object'
                ? new OutputCollector(
                      mode.maxBytes,
                      label,
                      mode.spill
                          ? {
                                ...mode.spill,
                                dir: binding.spillDir,
                                onFailure: binding.onSpillFailure,
                            }
                          : undefined,
                  )
                : undefined;
        return {
            pipe,
            collector,
            async push(data: Buffer) {
                if (collector) collector.push(data);
                else {
                    const target = pipe ?? process[label];
                    if (!target.write(data))
                        await once(target, 'drain', { signal });
                }
            },
        };
    };
    const stdout = output(spec.stdio.stdout, 'stdout');
    const stderr = output(spec.stdio.stderr, 'stderr');
    // No server-side timeout: it drops the gateway future before channel cleanup.
    const opened = connection.config.interactiveClient.execInteractive(
        connection.config.sandbox,
        [...spec.argv],
        {
            tty: false,
            noLoginShell: true,
            workdir: spec.cwd,
            timeoutSecs: 0,
            signal,
        },
    );
    void opened.catch(() => {});
    const writeInput = (session: OfficialExecSession, data: Buffer) => {
        // Leave room for protobuf framing under the official 1 MiB RPC limit.
        for (let offset = 0; offset < data.length; offset += 65536) {
            signal.throwIfAborted();
            session.write(data.subarray(offset, offset + 65536));
        }
    };
    const stdin =
        spec.stdio.stdin === 'pipe'
            ? new Writable({
                  write(chunk, _encoding, callback) {
                      void opened
                          .then((session) =>
                              writeInput(session, Buffer.from(chunk)),
                          )
                          .then(() => callback(), callback);
                  },
                  final(callback) {
                      void opened
                          .then((session) => session.closeInput())
                          .then(() => callback(), callback);
                  },
              })
            : undefined;
    stdin?.on('error', () => control.abort());
    const done = (async () => {
        let session: OfficialExecSession | undefined;
        try {
            session = await opened;
            if (typeof spec.stdio.stdin === 'object') {
                writeInput(session, Buffer.from(spec.stdio.stdin.data));
                session.closeInput();
            } else if (spec.stdio.stdin === 'ignore') session.closeInput();
            const pump = (async () => {
                for await (const event of session!.output) {
                    if ('stream' in event)
                        await (
                            event.stream === 'stdout' ? stdout : stderr
                        ).push(event.data);
                }
            })();
            // Drain output concurrently; success requires final SDK gRPC completion.
            const [, exitCode] = await Promise.all([pump, session.done]);
            return { exitCode, signal: null };
        } finally {
            session?.cancel();
            control.abort();
            stdin?.destroy();
            stdout.pipe?.end();
            stderr.pipe?.end();
            stdout.collector?.seal();
            stderr.collector?.seal();
        }
    })();
    void done.catch(() => {});
    const transportClosed = done.then(
        () => {},
        () => {},
    );
    return {
        stdin,
        stdout: stdout.pipe,
        stderr: stderr.pipe,
        control: undefined,
        collected: {
            ...(stdout.collector ? { stdout: stdout.collector } : {}),
            ...(stderr.collector ? { stderr: stderr.collector } : {}),
        },
        done,
        transportClosed,
        terminate: () => control.abort(),
        waitForExit: async (waitSignal) => {
            if (waitSignal?.aborted) return false;
            let abort: (() => void) | undefined;
            try {
                const finished = waitSignal
                    ? await Promise.race([
                          transportClosed.then(() => true),
                          new Promise<false>((resolve) => {
                              abort = () => resolve(false);
                              waitSignal.addEventListener('abort', abort, {
                                  once: true,
                              });
                          }),
                      ])
                    : (await transportClosed, true);
                if (!finished) return false;
                throw new Error('OpenShell remote exit unconfirmed');
            } finally {
                if (abort) waitSignal?.removeEventListener('abort', abort);
            }
        },
    };
}
