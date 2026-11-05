import assert from 'node:assert/strict';
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SandboxClient } from '../../sdk/dist/index.js';
const root = process.argv[2];
const credentials = join(root, 'mtls-credentials');
const gateway = 'https://127.0.0.1:18180';
const caCert = await readFile(join(credentials, 'ca.crt'));
const valid = await SandboxClient.connect({
    gateway,
    caCert,
    clientCert: await readFile(join(credentials, 'tls.crt')),
    clientKey: await readFile(join(credentials, 'tls.key')),
});
await valid.listAll();
const noCertificate = await SandboxClient.connect({ gateway, caCert });
await assert.rejects(
    noCertificate.listAll(),
    (error) => error.connectCode === 16,
);
const wrong = join(root, 'mtls-wrong-client');
const foreign = await SandboxClient.connect({
    gateway,
    caCert,
    clientCert: await readFile(join(wrong, 'tls.crt')),
    clientKey: await readFile(join(wrong, 'tls.key')),
});
await assert.rejects(
    foreign.listAll(),
    (error) =>
        [14, 16].includes(error.connectCode) ||
        /certificate|tls|ssl|socket|closed|reset|protocol|unavailable|handshake/i.test(
            error.message,
        ),
);
