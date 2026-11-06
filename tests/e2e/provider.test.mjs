import console from 'node:console';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { Context } from '@deepseek-ai/cordis';
import { SandboxClient } from '../../sdk/dist/index.js';
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess';
import { apply, OpenShellConnection } from '../../src/index.ts';
const root = process.argv[2];
const prepared = JSON.parse(
    await readFile(join(root, 'client/prepared.json'), 'utf8'),
);
const client = await SandboxClient.connect({
    gateway: 'http://127.0.0.1:18180',
});
const config = {
    interactiveClient: client,
    sandbox: prepared.sandboxes[0].name,
    helper: prepared.helper_path,
    executionTimeoutSeconds: 3,
};
const ctx = new Context();
const diagnostic = new Context();
const resultOf = async (handle) => {
    const outcome = await handle.done;
    return {
        ...outcome,
        stdout: handle.collected.stdout.readFrom(0).text,
        stderr: handle.collected.stderr.readFrom(0).text,
    };
};
const spawn = (ctx, argv, signal) =>
    ctx.subprocess.spawn({
        argv,
        cwd: '/sandbox/project',
        stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 65536 },
            stderr: { maxBytes: 65536 },
        },
        graceMs: 200,
        signal,
    });
try {
    await apply(ctx, config);
    await apply(diagnostic, { ...config, requireFullEnforcement: false });
    const backendFacts = JSON.parse(
        await ctx.subprocess.connection.capture(
            ['/usr/local/bin/node', '/opt/dsh-runtime/diagnostics.mjs'],
            '/sandbox',
        ),
    );
    assert.equal(backendFacts.dsh, '0.2.1-rc.4');
    console.log('DIAGNOSTIC: ' + JSON.stringify(backendFacts));
    const fsProgram = `const fs=require('node:fs'),cp=require('node:child_process');const paths=['/sandbox/project/file','/sandbox/outside','/opt/dsh-permission-outer/file'];const test=p=>{let file,shell;try{fs.writeFileSync(p,'ok');file='ok'}catch(e){file=e.code}const r=cp.spawnSync('/bin/sh',['-c','printf ok > "$1"','sh',p],{encoding:'utf8'});shell=r.status===0?'ok':(/Permission denied|Read-only/.test(r.stderr)?'denied':r.stderr);return{file,shell}};console.log(JSON.stringify(paths.map(test)));`;
    const argv = ['/usr/local/bin/node', '-e', fsProgram];
    for (const mode of ['read-only', 'workspace-write']) {
        const policy = { mode, workspaceRoot: '/sandbox/project' };
        const wrapped = await diagnostic.sandbox.confine(argv, policy);
        const result = await resultOf(spawn(diagnostic, wrapped.argv));
        assert.equal(result.exitCode, 0, result.stderr);
        const rows = JSON.parse(result.stdout);
        assert.equal(
            rows[0].file,
            mode === 'workspace-write' ? 'ok' : 'EACCES',
        );
        assert.equal(
            rows[0].shell,
            mode === 'workspace-write' ? 'ok' : 'denied',
        );
        assert.equal(rows[1].file, 'EACCES');
        assert.equal(rows[1].shell, 'denied');
        assert.equal(rows[2].file, 'EACCES');
        assert.equal(rows[2].shell, 'denied');
        if (wrapped.enforcement === 'partial')
            await assert.rejects(
                ctx.sandbox.confine(argv, policy),
                /full confinement required/,
            );
        else
            assert.equal(
                (await ctx.sandbox.confine(argv, policy)).enforcement,
                'full',
            );
        console.log(
            'PASS: ' +
                mode +
                ' file/shell boundary; enforcement=' +
                wrapped.enforcement,
        );
    }
    const unrestricted = await resultOf(spawn(ctx, argv));
    assert.equal(unrestricted.exitCode, 0, unrestricted.stderr);
    const fullRows = JSON.parse(unrestricted.stdout);
    assert.equal(fullRows[0].file, 'ok');
    assert.equal(fullRows[1].file, 'ok');
    assert.equal(fullRows[2].file, 'EACCES');
    console.log(
        'PASS: OpenShell outer policy remains effective for unconfined calls',
    );
    const cwd = await resultOf(
        spawn(ctx, [
            '/usr/local/bin/node',
            '-e',
            'console.log(process.cwd());console.error("stderr-literal");process.exitCode=7',
        ]),
    );
    assert.equal(cwd.exitCode, 7);
    assert.equal(cwd.stdout.trim(), '/sandbox/project');
    assert(cwd.stderr.includes('stderr-literal'));
    console.log('PASS: remote cwd, stdout/stderr and nonzero exit code');
    assert.equal(
        await ctx.subprocess.resolveExecutable('node'),
        '/usr/local/bin/node',
    );
    await assert.rejects(
        ctx.subprocess.resolveExecutable('dsh-definitely-not-installed'),
        SubprocessExecutableNotFoundError,
    );
    const literal = 'literal $(touch /sandbox/forbidden); spaces';
    const echo = ctx.subprocess.spawn({
        argv: [
            '/usr/local/bin/node',
            '-e',
            'process.stdin.pipe(process.stdout);process.stderr.write(process.argv[1])',
            literal,
        ],
        cwd: '/sandbox/project',
        stdio: {
            stdin: { data: 'input-bytes' },
            stdout: { maxBytes: 4096 },
            stderr: { maxBytes: 4096 },
        },
        graceMs: 200,
    });
    const echoed = await resultOf(echo);
    assert.equal(echoed.exitCode, 0, echoed.stderr);
    assert.equal(echoed.stdout, 'input-bytes');
    assert.equal(echoed.stderr, literal);
    console.log(
        'PASS: executable lookup, stdin and literal argument transport',
    );
    const payload = Buffer.from('跨帧 stdin 🚀\n'.repeat(90000));
    assert(payload.length > 1024 * 1024);
    const digest = createHash('sha256').update(payload).digest('hex');
    for (const piped of [false, true]) {
        const large = ctx.subprocess.spawn({
            argv: [
                '/usr/local/bin/node',
                '-e',
                "const h=require('node:crypto').createHash('sha256');process.stdin.on('data',b=>h.update(b));process.stdin.on('end',()=>console.log(h.digest('hex')));",
            ],
            cwd: '/sandbox/project',
            stdio: {
                stdin: piped ? 'pipe' : { data: payload },
                stdout: { maxBytes: 4096 },
                stderr: { maxBytes: 4096 },
            },
            graceMs: 200,
        });
        if (piped) large.stdin.end(payload);
        const result = await resultOf(large);
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.stdout.trim(), digest);
    }
    console.log(
        'PASS: >1 MiB fixed and piped stdin preserves exact remote SHA-256',
    );
    const other = new OpenShellConnection({
        ...config,
        sandbox: prepared.sandboxes[1].name,
    });
    assert.equal(
        (
            await other.capture(['/bin/cat', '/sandbox/identity'], '/sandbox')
        ).trim(),
        'ONLY-1',
    );
    assert.equal(
        (
            await ctx.subprocess.connection.capture(
                ['/bin/cat', '/sandbox/identity'],
                '/sandbox',
            )
        ).trim(),
        'ONLY-0',
    );
    console.log('PASS: configured sandbox target isolation');
} finally {
    await diagnostic.fiber.dispose();
    await ctx.fiber.dispose();
}
