import process from 'node:process';
import { once } from 'node:events';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox';
import { FsError } from '@deepseek-ai/dsh-fs';
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock';
const VERSION = '0.2.1-rc.4',
    LIMIT = 1024 * 1024;
const require = createRequire(import.meta.url);
const ctx = new Context();
async function boundedText(fs, target) {
    let bytes = 0,
        text = '';
    for await (const chunk of await fs.streamText(target)) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > LIMIT)
            throw new FsError('Text exceeds transport cap', 'FS_TOO_LARGE');
        text += chunk;
    }
    return text;
}
let lock;
try {
    if (require('@deepseek-ai/dsh-fs-sandbox/package.json').version !== VERSION)
        throw new Error('filesystem helper version mismatch');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
        bytes += chunk.length;
        if (bytes > LIMIT + 65536)
            throw new FsError('Request exceeds transport cap', 'FS_TOO_LARGE');
        chunks.push(chunk);
    }
    const r = JSON.parse(Buffer.concat(chunks).toString());
    if (
        r.version !== VERSION ||
        typeof r.workspaceRoot !== 'string' ||
        !r.workspaceRoot.startsWith('/')
    )
        throw new Error('Invalid filesystem request');
    ctx.reflect.provide('sandboxPolicy', {
        defaultMode: r.defaultMode,
        resolve: () => ({
            mode: r.defaultMode,
            workspaceRoot: r.workspaceRoot,
        }),
    });
    await ctx.plugin(SandboxedFileSystem, {
        cwd: r.workspaceRoot,
        diffBasisMaxBytes: LIMIT,
    });
    const fs = ctx.fs;
    if (
        (await fs.stat(await fs.resolve(r.workspaceRoot)))?.type !== 'directory'
    )
        throw new FsError('Workspace is not a directory', 'FS_NOT_DIRECTORY');
    const methods = [
        'resolve',
        'stat',
        'lstat',
        'readText',
        'streamText',
        'readBytes',
        'readByteRange',
        'listDir',
        'writeText',
        'editText',
    ];
    if (!methods.includes(r.method))
        throw new Error('Unknown filesystem operation');
    const target = await fs.resolve(r.path, { cwd: r.cwd ?? r.workspaceRoot });
    const mutation = r.method === 'writeText' || r.method === 'editText';
    if (mutation) {
        // Fail read-only before even creating the mutation lock file.
        if (r.policy.mode === 'read-only')
            throw new FsError(
                'File access denied under read-only mode',
                'FS_SANDBOX_DENIED',
            );
        const dir = `/tmp/dsh-openshell-fs-${process.getuid()}`;
        await mkdir(dir, { mode: 0o700 }).catch((e) => {
            if (e.code !== 'EEXIST') throw e;
        });
        const info = await lstat(dir);
        if (
            !info.isDirectory() ||
            info.uid !== process.getuid() ||
            info.mode & 0o077
        )
            throw new Error('Unsafe filesystem lock directory');
        const key = createHash('sha256')
            .update(String(target.targetKey))
            .digest('hex');
        lock = await open(
            `${dir}/${key}`,
            constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
            0o600,
        );
        const deadline = Date.now() + 10000;
        while (true) {
            try {
                await tryLockExclusive(lock.fd);
                break;
            } catch (e) {
                if (
                    !['EAGAIN', 'EWOULDBLOCK'].includes(e.code) ||
                    Date.now() >= deadline
                )
                    throw e;
                await setTimeout(10);
            }
        }
    }
    if (r.method === 'readText' && ((await fs.stat(target))?.size ?? 0) > LIMIT)
        throw new FsError(
            'Text exceeds transport cap; use byte windows',
            'FS_TOO_LARGE',
        );
    if (r.method === 'writeText' && Buffer.byteLength(r.content) > LIMIT)
        throw new FsError('Text exceeds transport cap', 'FS_TOO_LARGE');
    let value;
    switch (r.method) {
        case 'resolve':
            value = target;
            break;
        case 'stat':
            value = await fs.stat(target);
            break;
        case 'lstat':
            value = await fs.lstat(r.path, { cwd: r.cwd ?? r.workspaceRoot });
            break;
        case 'readText':
            value = await boundedText(fs, target);
            break;
        case 'streamText':
            for await (const chunk of await fs.streamText(target)) {
                if (
                    !process.stdout.write(
                        JSON.stringify({ version: VERSION, value: chunk }) +
                            '\n',
                    )
                )
                    await once(process.stdout, 'drain');
            }
            process.stdout.write(
                JSON.stringify({ version: VERSION, done: true }) + '\n',
            );
            break;
        case 'readBytes':
            value = Buffer.from(
                await fs.readBytes(
                    target,
                    undefined,
                    Math.min(r.maxBytes, LIMIT),
                ),
            ).toString('base64');
            break;
        case 'readByteRange':
            if (
                !Number.isSafeInteger(r.range.length) ||
                r.range.length < 0 ||
                r.range.length > LIMIT
            )
                throw new FsError('Byte window exceeds cap', 'FS_TOO_LARGE');
            value = Buffer.from(
                await fs.readByteRange(target, r.range),
            ).toString('base64');
            break;
        case 'listDir':
            value = await fs.listDir(target);
            break;
        case 'writeText':
            value = await fs.writeText(
                target,
                r.content,
                r.expected,
                undefined,
                r.policy,
            );
            break;
        case 'editText': {
            // Budget only: the official provider still owns edit validation,
            // stale checking, replacement, line endings and atomic publication.
            const metadata = await fs.stat(target);
            if (
                metadata?.type === 'file' &&
                (!r.expected || r.expected.version === metadata.version)
            ) {
                if ((metadata.size ?? 0) > LIMIT)
                    throw new FsError(
                        'Text exceeds transport cap',
                        'FS_TOO_LARGE',
                    );
                const before = (await boundedText(fs, target)).replaceAll(
                    '\r\n',
                    '\n',
                );
                const oldText = r.edit.oldString.replaceAll('\r\n', '\n');
                const newText = r.edit.newString.replaceAll('\r\n', '\n');
                let count = 0,
                    offset = 0;
                if (oldText)
                    while ((offset = before.indexOf(oldText, offset)) !== -1) {
                        count++;
                        offset += oldText.length;
                    }
                if (
                    count &&
                    (r.edit.replaceAll || count === 1) &&
                    Buffer.byteLength(before) +
                        count *
                            (Buffer.byteLength(newText) -
                                Buffer.byteLength(oldText)) >
                        LIMIT
                )
                    throw new FsError(
                        'Edit result exceeds transport cap',
                        'FS_TOO_LARGE',
                    );
            }
            value = await fs.editText(
                target,
                r.edit,
                r.expected,
                undefined,
                r.policy,
            );
            break;
        }
    }
    const output = JSON.stringify({ version: VERSION, value: value ?? null });
    if (Buffer.byteLength(output) > 16 * LIMIT)
        throw new FsError('Response exceeds transport cap', 'FS_TOO_LARGE');
    if (r.method !== 'streamText') process.stdout.write(output);
} catch (e) {
    process.stdout.write(
        JSON.stringify({
            version: VERSION,
            error: {
                code: ['EACCES', 'EPERM', 'EROFS'].includes(e.code)
                    ? 'FS_PERMISSION_DENIED'
                    : (e.code ?? 'FS_IO_ERROR'),
                message: e.message,
            },
        }) + '\n',
    );
} finally {
    await lock?.close();
    await ctx.fiber.dispose();
}
