import assert from 'node:assert/strict';
import console from 'node:console';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { SandboxClient } from '../../sdk/dist/index.js';
import { apply } from '../../src/index.ts';
const root = process.argv[2];
const prepared = JSON.parse(
    await readFile(join(root, 'client/prepared.json'), 'utf8'),
);
const gatewayEndpoint = 'http://127.0.0.1:18180';
const client = await SandboxClient.connect({ gateway: gatewayEndpoint });
const ctx = new Context();
const config = {
    interactiveClient: client,
    sandbox: prepared.sandboxes[0].name,
    helper: prepared.helper_path,
    executionTimeoutSeconds: 2,
};
const spawn = (argv, signal) =>
    ctx.subprocess.spawn({
        argv,
        cwd: '/sandbox/project',
        signal,
        stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 65536 },
            stderr: { maxBytes: 65536 },
        },
        graceMs: 200,
    });
try {
    await apply(ctx, config);
    for (const mode of ['cancel', 'deadline', 'detached', 'dispose']) {
        const prefix = 'sdk-adapter-' + mode;
        const program = `const fs=require('node:fs'),cp=require('node:child_process');const start=p=>fs.readFileSync('/proc/'+p+'/stat','utf8').split(') ').at(-1).split(' ')[19];const c=cp.spawn(process.execPath,['-e',"setTimeout(()=>require('node:fs').writeFileSync('/sandbox/project/${prefix}.late','yes'),3500);setTimeout(()=>{},20000)"],{stdio:'ignore',detached:${mode === 'detached'}});fs.writeFileSync('/sandbox/project/${prefix}.json',JSON.stringify({pid:process.pid,start:start(process.pid),child:c.pid,childStart:start(c.pid)}));console.log('READY');setTimeout(()=>{},20000);`;
        const control = new globalThis.AbortController();
        const h = spawn(['/usr/local/bin/node', '-e', program], control.signal);
        for (
            let i = 0;
            !h.collected.stdout.readFrom(0).text.includes('READY');
            i++
        ) {
            assert(i < 60, 'adapter readiness timeout');
            await delay(25);
        }
        if (mode === 'cancel' || mode === 'detached') control.abort();
        if (mode === 'dispose') await ctx.fiber.dispose();
        await assert.rejects(h.done);
        await assert.rejects(h.waitForExit(), /remote exit unconfirmed/);
        await delay(3800);
        // Independent official client; no dependency on the adapter's closed transport.
        const state = await client.exec(
            config.sandbox,
            [
                '/usr/local/bin/node',
                '-e',
                `const fs=require('node:fs'),d=JSON.parse(fs.readFileSync('/sandbox/project/${prefix}.json','utf8'));const alive=(p,s)=>{try{const f=fs.readFileSync('/proc/'+p+'/stat','utf8').split(') ').at(-1).split(' ');return f[19]===s&&!['Z','X'].includes(f[0]);}catch(e){if(e.code==='ENOENT')return false;throw e;}};console.log(JSON.stringify({parent:alive(d.pid,d.start),child:alive(d.child,d.childStart),late:fs.existsSync('/sandbox/project/${prefix}.late')}));`,
            ],
            { noLoginShell: true, timeoutSecs: 10 },
        );
        assert.deepEqual(JSON.parse(state.stdout.toString()), {
            parent: false,
            child: mode === 'detached',
            late: mode === 'detached',
        });
        if (mode === 'detached') {
            console.log(
                'OBSERVED: SDK cancellation stops parent but setsid child survives; range exit remains unconfirmed',
            );
            continue;
        }
        console.log(
            'PASS: SDK adapter ' +
                mode +
                ' stops observed parent/group child; range exit remains unconfirmed',
        );
    }
} finally {
    await ctx.fiber.dispose();
}
