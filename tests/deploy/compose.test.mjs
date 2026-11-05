import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { deploy } from '../../deploy/openshell/deploy.mjs';
const config = {
    name: 'test-sandbox',
    image: 'test-runtime:rc4',
    policy: '/policy.yaml',
    timeout: 1,
};
const key = createHash('sha256')
    .update(config.image)
    .digest('hex')
    .slice(0, 32);
let existing = false,
    owned = true,
    failList = false,
    failPolicy = false,
    version = '0.1.6';
const calls = [];
const run = async (args) => {
    calls.push(args);
    if (args[0] === '--version') return 'openshell ' + version;
    if (args[1] === 'list') {
        if (failList) throw new Error('Gateway unavailable');
        return JSON.stringify({
            sandboxes: existing
                ? [
                      {
                          name: config.name,
                          labels: owned
                              ? {
                                    'dsh-openshell': 'compose',
                                    'dsh-runtime': key,
                                }
                              : {},
                      },
                  ]
                : [],
        });
    }
    if (args[1] === 'create') {
        existing = true;
        return '';
    }
    if (args[1] === 'set') {
        if (failPolicy) throw new Error('Policy not loaded');
        return '';
    }
    return JSON.stringify({ id: 'fixed-id', phase: 'Ready' });
};
assert.equal((await deploy(config, run)).created, true);
assert.equal((await deploy(config, run)).created, false);
assert.equal(calls.filter((args) => args[1] === 'create').length, 1);
assert(
    calls
        .filter((args) => args[1] === 'set')
        .every((args) => args.includes('--wait')),
);
owned = false;
await assert.rejects(deploy(config, run), /ownership or image/);
owned = true;
failList = true;
await assert.rejects(deploy(config, run), /Gateway unavailable/);
failList = false;
failPolicy = true;
await assert.rejects(deploy(config, run), /Policy not loaded/);
failPolicy = false;
version = '0.2.0';
await assert.rejects(deploy(config, run), /0.1.6 required/);

const count = calls.length;
await assert.rejects(
    deploy({ ...config, name: 'dsh-sandbox-openshell' }, run),
    /Sandbox name must be a DNS label/,
);
assert.equal(calls.length, count);

const compose = await readFile(
    new globalThis.URL('../../deploy/compose.yaml', import.meta.url),
    'utf8',
);
const example = await readFile(
    new globalThis.URL('../../.env.example', import.meta.url),
    'utf8',
);
const defaultName = compose.match(/DSH_OPENSHELL_SANDBOX:-([^}]+)/)[1];
assert.equal(example.match(/^DSH_OPENSHELL_SANDBOX=(.*)$/m)[1], defaultName);
version = '0.1.6';
existing = false;
assert.equal(
    (await deploy({ ...config, name: defaultName }, run)).created,
    true,
);
console.log(
    'PASS: one-shot deployment creation, repeat reuse, ownership conflict, API failure, policy wait and CLI version',
);
