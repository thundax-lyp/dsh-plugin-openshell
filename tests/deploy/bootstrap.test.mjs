import assert from 'node:assert/strict';
import console from 'node:console';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCli, deployCompose } from '../../deploy/deploy.mjs';
const root = await mkdtemp(join(tmpdir(), 'dsh-bootstrap-'));
try {
    const path = join(root, 'openshell');
    await assert.rejects(
        prepareCli(path, { explicit: true }),
        /does not exist/,
    );
    await assert.rejects(
        prepareCli(path, { download: async () => new Uint8Array([1]) }),
        /checksum mismatch/,
    );
    await assert.rejects(
        prepareCli(path, {
            download: async () => {
                throw new Error('network unavailable');
            },
        }),
        /DSH_OPENSHELL_CLI_PATH/,
    );
    assert.deepEqual(await readdir(root), []);
    await writeFile(path, 'existing binary');
    await prepareCli(path, {
        invoke: async () => 'openshell 0.1.6',
        download: async () => {
            throw new Error('must reuse');
        },
    });
    await assert.rejects(
        prepareCli(path, { invoke: async () => 'openshell 0.1.7' }),
        /0.1.6 required/,
    );
    let code = '0',
        logs = '{"status":"READY"}',
        waitError = false;
    const calls = [];
    const invoke = async (command, args) => {
        calls.push([command, args]);
        if (args[0] === 'wait') {
            if (waitError) throw new Error('wait timeout');
            return code;
        }
        if (args.includes('ps')) return 'container-id';
        if (args.includes('logs')) return logs;
        return '';
    };
    await deployCompose({}, invoke);
    code = '1';
    await assert.rejects(deployCompose({}, invoke), /exited with 1/);
    code = '0';
    logs = 'incomplete';
    await assert.rejects(deployCompose({}, invoke), /did not report READY/);
    waitError = true;
    await assert.rejects(deployCompose({}, invoke), /wait timeout/);
    assert.equal(calls.filter(([, args]) => args.includes('up')).length, 4);
    console.log(
        'PASS: CLI reuse/version/checksum/cleanup and Compose completion/failure/timeout without retries',
    );
} finally {
    await rm(root, { recursive: true, force: true });
}
