import { posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { FileSystem, FsError, FsTargetKey } from '@deepseek-ai/dsh-fs';
import type {
    FsTarget,
    FsInfo,
    FsPathInfo,
    FsDirEntry,
    FsEditRequest,
    FsEditOutcome,
    FsWriteIntent,
    FsWriteOutcome,
    FsVersion,
    FsErrorCode,
} from '@deepseek-ai/dsh-fs';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import { OpenShellSubprocessRuntime } from '../subprocess/provider.ts';
import { inside } from '../workspace/binding.ts';

const LIMIT = 1024 * 1024;
const codes = new Set<FsErrorCode>([
    'FS_NOT_FOUND',
    'FS_NOT_DIRECTORY',
    'FS_NOT_TEXT',
    'FS_NOT_REGULAR_FILE',
    'FS_TOO_LARGE',
    'FS_PERMISSION_DENIED',
    'FS_SANDBOX_DENIED',
    'FS_IO_ERROR',
    'FS_STALE_VERSION',
    'FS_NOT_OBSERVED',
    'FS_AMBIGUOUS_EDIT',
    'FS_EDIT_NOT_FOUND',
    'FS_ABORTED',
]);

/** DSH filesystem seam, backed exclusively by the matching OpenShell SDK client. */
export class OpenShellFileSystem extends FileSystem {
    static inject = ['subprocess', 'openShellWorkspace'];
    private readonly runtime: OpenShellSubprocessRuntime;
    private readonly lifecycle = new AbortController();
    private readonly namespace = randomUUID();
    private readonly paths = new Map<string, string>();
    constructor(ctx: Context) {
        super(ctx);
        if (!(ctx.subprocess instanceof OpenShellSubprocessRuntime))
            throw new Error('matching OpenShell subprocess provider required');
        this.runtime = ctx.subprocess;
        ctx.effect(
            () => () => this.lifecycle.abort(),
            'OpenShell filesystem teardown',
        );
    }
    get sandboxMode() {
        return this.runtime.connection.config.defaultMode!;
    }
    private target(remote: FsTarget): FsTarget {
        if (
            !remote ||
            typeof remote.targetKey !== 'string' ||
            !posix.isAbsolute(remote.targetKey) ||
            remote.targetKey.includes('\0')
        )
            throw new FsError('Invalid remote target', 'FS_IO_ERROR');
        const key = FsTargetKey(this.namespace + ':' + remote.targetKey);
        this.paths.set(key, remote.targetKey);
        return Object.freeze({ targetKey: key, displayPath: remote.targetKey });
    }
    processPath(target: FsTarget) {
        const path = this.paths.get(target.targetKey);
        if (!path)
            throw new FsError(
                'Target belongs to another execution world',
                'FS_IO_ERROR',
            );
        return path;
    }
    fileUrl(target: FsTarget) {
        return (
            'file://' +
            this.processPath(target)
                .split('/')
                .map(encodeURIComponent)
                .join('/')
        );
    }
    contains(parent: FsTarget, child: FsTarget) {
        return inside(this.processPath(parent), this.processPath(child));
    }
    async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }) {
        return this.target(
            await this.call<FsTarget>(
                'resolve',
                { path, cwd: opts?.cwd ?? this.ctx.openShellWorkspace.root },
                opts?.signal,
            ),
        );
    }
    stat(target: FsTarget, signal?: AbortSignal) {
        return this.call<FsInfo | undefined>(
            'stat',
            { path: this.processPath(target) },
            signal,
        ).then((v) => v ?? undefined);
    }
    lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal) {
        return this.call<FsPathInfo | undefined>(
            'lstat',
            { path, cwd: opts?.cwd ?? this.ctx.openShellWorkspace.root },
            signal,
        ).then((v) => v ?? undefined);
    }
    readText(target: FsTarget, signal?: AbortSignal) {
        return this.call<string>(
            'readText',
            { path: this.processPath(target) },
            signal,
        );
    }
    async streamText(
        target: FsTarget,
        signal?: AbortSignal,
    ): Promise<AsyncIterable<string>> {
        const path = this.processPath(target);
        if (signal?.aborted || this.lifecycle.signal.aborted)
            throw new FsError('Filesystem stream aborted', 'FS_ABORTED');
        const c = this.runtime.connection;
        const controller = new AbortController();
        const combined = AbortSignal.any([
            controller.signal,
            this.lifecycle.signal,
            AbortSignal.timeout(c.config.executionTimeoutSeconds! * 1000),
            ...(signal ? [signal] : []),
        ]);
        const request = Buffer.from(
            JSON.stringify({
                version: '0.2.1-rc.4',
                method: 'streamText',
                path,
                workspaceRoot: this.ctx.openShellWorkspace.root,
                defaultMode: this.sandboxMode,
            }),
        );
        const requestRoot = this.ctx.openShellWorkspace.root;
        return (async function* () {
            let pending = Buffer.alloc(0),
                ended = false;
            let session:
                | Awaited<
                      ReturnType<
                          typeof c.config.interactiveClient.execInteractive
                      >
                  >
                | undefined;
            try {
                combined.throwIfAborted();
                session = await c.config.interactiveClient.execInteractive(
                    c.config.sandbox,
                    [
                        c.config.node ?? '/usr/local/bin/node',
                        c.config.fileSystemHelper!,
                    ],
                    {
                        tty: false,
                        noLoginShell: true,
                        workdir: requestRoot,
                        timeoutSecs: 0,
                        signal: combined,
                    },
                );
                void session.done.catch(() => {});
                session.write(request);
                session.closeInput();
                for await (const event of session.output) {
                    combined.throwIfAborted();
                    if (!('stream' in event) || event.stream !== 'stdout')
                        continue;
                    pending = Buffer.concat([pending, event.data]);
                    let end;
                    while ((end = pending.indexOf(10)) !== -1) {
                        if (end > LIMIT)
                            throw new FsError(
                                'Filesystem stream record exceeds cap',
                                'FS_TOO_LARGE',
                            );
                        const record = JSON.parse(
                            pending.subarray(0, end).toString(),
                        );
                        pending = pending.subarray(end + 1);
                        if (record.version !== '0.2.1-rc.4')
                            throw new Error(
                                'Filesystem helper version mismatch',
                            );
                        if (record.error)
                            throw new FsError(
                                String(record.error.message),
                                codes.has(record.error.code)
                                    ? record.error.code
                                    : 'FS_IO_ERROR',
                            );
                        if (record.done === true) ended = true;
                        else if (typeof record.value === 'string' && !ended)
                            yield record.value;
                        else
                            throw new Error('Invalid filesystem stream record');
                    }
                    if (pending.length > LIMIT)
                        throw new FsError(
                            'Filesystem stream record exceeds cap',
                            'FS_TOO_LARGE',
                        );
                }
                if ((await session.done) !== 0 || !ended || pending.length)
                    throw new Error(
                        'Filesystem stream ended without completion',
                    );
            } catch (error) {
                if (error instanceof FsError) throw error;
                throw new FsError(
                    'OpenShell filesystem stream failed',
                    combined.aborted ? 'FS_ABORTED' : 'FS_IO_ERROR',
                    { cause: error },
                );
            } finally {
                session?.cancel();
                controller.abort();
            }
        })();
    }

    async readBytes(
        target: FsTarget,
        signal: AbortSignal | undefined,
        maxBytes: number,
    ) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
            throw new FsError('Invalid byte cap', 'FS_TOO_LARGE');
        return Buffer.from(
            await this.call<string>(
                'readBytes',
                {
                    path: this.processPath(target),
                    maxBytes: Math.min(maxBytes, LIMIT),
                },
                signal,
            ),
            'base64',
        );
    }
    async readByteRange(
        target: FsTarget,
        range: { offset: number; length: number },
        signal?: AbortSignal,
    ) {
        if (
            !Number.isSafeInteger(range.offset) ||
            range.offset < 0 ||
            !Number.isSafeInteger(range.length) ||
            range.length < 0 ||
            range.length > LIMIT
        )
            throw new FsError(
                'Invalid or excessive byte window',
                'FS_TOO_LARGE',
            );
        return Buffer.from(
            await this.call<string>(
                'readByteRange',
                { path: this.processPath(target), range },
                signal,
            ),
            'base64',
        );
    }
    async listDir(target: FsTarget, signal?: AbortSignal) {
        const entries = await this.call<FsDirEntry[]>(
            'listDir',
            { path: this.processPath(target) },
            signal,
        );
        return entries.map((entry) => ({
            ...entry,
            target: this.target(entry.target),
        }));
    }
    async writeText(
        target: FsTarget,
        content: string,
        expected?: FsWriteIntent,
        signal?: AbortSignal,
        policy?: SandboxExecutionPolicy,
    ) {
        return this.call<FsWriteOutcome>(
            'writeText',
            {
                path: this.processPath(target),
                content,
                expected,
                policy: this.policy(policy),
            },
            signal,
        );
    }
    async editText(
        target: FsTarget,
        edit: FsEditRequest,
        expected?: { version: FsVersion },
        signal?: AbortSignal,
        policy?: SandboxExecutionPolicy,
    ) {
        return this.call<FsEditOutcome>(
            'editText',
            {
                path: this.processPath(target),
                edit,
                expected,
                policy: this.policy(policy),
            },
            signal,
        );
    }
    private policy(policy?: SandboxExecutionPolicy) {
        const result = policy ?? {
            mode: this.sandboxMode,
            workspaceRoot: this.ctx.openShellWorkspace.root,
        };
        if (
            !['read-only', 'workspace-write', 'danger-full-access'].includes(
                result.mode,
            ) ||
            !posix.isAbsolute(result.workspaceRoot) ||
            !inside(this.ctx.openShellWorkspace.root, result.workspaceRoot)
        )
            throw new FsError(
                'Policy root is outside the bound workspace',
                'FS_SANDBOX_DENIED',
            );
        return result;
    }
    private async call<T>(
        method: string,
        params: object,
        signal?: AbortSignal,
    ): Promise<T> {
        signal = AbortSignal.any([
            this.lifecycle.signal,
            ...(signal ? [signal] : []),
        ]);
        try {
            signal.throwIfAborted();
            const request = Buffer.from(
                JSON.stringify({
                    version: '0.2.1-rc.4',
                    method,
                    workspaceRoot: this.ctx.openShellWorkspace.root,
                    defaultMode: this.sandboxMode,
                    ...params,
                }),
            );
            if (request.length > LIMIT + 65536)
                throw new FsError(
                    'Filesystem request exceeds transport cap',
                    'FS_TOO_LARGE',
                );
            const c = this.runtime.connection;
            const response = JSON.parse(
                await c.capture(
                    [
                        c.config.node ?? '/usr/local/bin/node',
                        c.config.fileSystemHelper!,
                    ],
                    this.ctx.openShellWorkspace.root,
                    signal,
                    request,
                    16 * LIMIT,
                ),
            );
            if (response.version !== '0.2.1-rc.4')
                throw new Error('Filesystem helper version mismatch');
            if (response.error)
                throw new FsError(
                    String(response.error.message),
                    codes.has(response.error.code)
                        ? response.error.code
                        : 'FS_IO_ERROR',
                );
            return response.value as T;
        } catch (error) {
            if (signal?.aborted)
                throw new FsError(
                    'Filesystem operation aborted',
                    'FS_ABORTED',
                    { cause: error },
                );
            if (error instanceof FsError) throw error;
            throw new FsError(
                'OpenShell filesystem operation failed',
                'FS_IO_ERROR',
                { cause: error },
            );
        }
    }
}
