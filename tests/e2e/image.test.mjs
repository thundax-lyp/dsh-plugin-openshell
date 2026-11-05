import assert from 'node:assert/strict';
import console from 'node:console';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { Context } from '@deepseek-ai/cordis';
import { SandboxClient } from '../../sdk/dist/index.js';
import { apply } from '../../src/index.ts';
const root = process.argv[2];
const prepared = JSON.parse(
    await readFile(join(root, 'client/prepared.json'), 'utf8'),
);
const client = await SandboxClient.connect({
    gateway: 'http://127.0.0.1:18180',
});
const config = {
    interactiveClient: client,
    sandbox: prepared.runtime_sandbox.name,
    helper: prepared.helper_path,
};
const strict = new Context(),
    diagnostic = new Context();
try {
    await apply(strict, config);
    await apply(diagnostic, { ...config, requireFullEnforcement: false });
    const facts = JSON.parse(
        await strict.subprocess.connection.capture(
            [
                '/usr/local/bin/node',
                '-e',
                `const fs=require('node:fs'),{createRequire}=require('node:module');const requireRuntime=createRequire('/opt/dsh-runtime/confine.mjs');const paths=['/opt/dsh-runtime/confine.mjs','/opt/dsh-runtime/fs.mjs','/opt/dsh-runtime/node_modules/@vscode/ripgrep-linux-x64/bin/rg','/opt/dsh-runtime/package-lock.json'];const protectedFiles=paths.every(p=>{const stat=fs.statSync(p);if(stat.uid!==0||(stat.mode&0o222)!==0)return false;try{const fd=fs.openSync(p,'a');fs.closeSync(fd);return false;}catch(e){return ['EACCES','EPERM','EROFS'].includes(e.code);}});console.log(JSON.stringify({uid:process.getuid(),node:process.versions.node,dsh:requireRuntime('@deepseek-ai/dsh-sandbox-local/package.json').version,protectedFiles,diagnosticsPresent:fs.existsSync('/opt/dsh-runtime/diagnostics.mjs'),deploymentPresent:['/run/deploy','/run/openshell-credentials','/usr/local/bin/openshell'].some(p=>fs.existsSync(p))}));`,
            ],
            '/sandbox/project',
        ),
    );
    assert.equal(facts.uid, 1000);
    assert.equal(facts.node.split('.')[0], '24');
    assert.equal(facts.dsh, '0.2.1-rc.4');
    assert.equal(facts.protectedFiles, true);
    assert.equal(facts.diagnosticsPresent, false);
    assert.equal(facts.deploymentPresent, false);
    const policy = {
        mode: 'workspace-write',
        workspaceRoot: '/sandbox/project',
    };
    const argv = [
        '/usr/local/bin/node',
        '-e',
        "const fs=require('node:fs');fs.writeFileSync('image-sdk-proof','connected');console.log(fs.readFileSync('image-sdk-proof','utf8'));console.log(process.cwd());",
    ];
    const wrapped = await diagnostic.sandbox.confine(argv, policy);
    if (wrapped.enforcement === 'partial')
        await assert.rejects(
            strict.sandbox.confine(argv, policy),
            /full confinement required/,
        );
    const handle = diagnostic.subprocess.spawn({
        argv: wrapped.argv,
        cwd: policy.workspaceRoot,
        stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 4096 },
            stderr: { maxBytes: 4096 },
        },
        graceMs: 200,
    });
    assert.equal(
        (await handle.done).exitCode,
        0,
        handle.collected.stderr.readFrom(0).text,
    );
    assert.equal(
        handle.collected.stdout.readFrom(0).text,
        'connected\n/sandbox/project\n',
    );
    console.log(
        'PASS: production image without fixture files, non-root UID, immutable RC helper and external DSH SDK execution; enforcement=' +
            wrapped.enforcement,
    );
} finally {
    await diagnostic.fiber.dispose();
    await strict.fiber.dispose();
}
