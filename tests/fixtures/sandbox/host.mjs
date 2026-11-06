import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, access, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import process from 'node:process';
import { URL } from 'node:url';
import { command, delay } from '../support/process.mjs';
import { buildRuntime } from '../runtime/build.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export class SandboxHost {
    constructor(root, config) {
        this.root = root;
        this.config = config;
        this.base = resolve(homedir(), config.remoteHome);
        this.cliPath = join(this.base, 'bin/openshell');
        this.endpoint = 'http://127.0.0.1:18180';
        this.statePath = join(root, 'state.json');
    }
    async save() {
        await writeFile(this.statePath, JSON.stringify(this.state), {
            mode: 0o600,
        });
    }
    cli(args, options = {}) {
        return command(
            [
                this.cliPath,
                ...(this.state?.mtls ? ['--gateway', 'deployment'] : []),
                '--gateway-endpoint',
                this.state?.mtls ? 'https://127.0.0.1:18180' : this.endpoint,
                ...args,
            ],
            {
                ...options,
                ...(this.state?.mtls
                    ? {
                          env: {
                              ...process.env,
                              XDG_CONFIG_HOME: join(this.root, 'mtls-config'),
                          },
                      }
                    : {}),
            },
        );
    }
    async facts(name) {
        return JSON.parse(
            (await this.cli(['sandbox', 'get', name, '-o', 'json'])).stdout,
        );
    }
    async prepare() {
        await assert.rejects(access(this.statePath));
        for (const port of [18180, 18181, 18182]) {
            const server = createServer();
            server.listen(port, '127.0.0.1');
            await once(server, 'listening');
            await new Promise((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
        }
        const original = await readFile(join(this.base, 'gateway.toml'));
        const baseline = JSON.parse(
            (
                await command([
                    this.cliPath,
                    '--gateway-endpoint',
                    'http://127.0.0.1:18080',
                    'sandbox',
                    'list',
                    '-o',
                    'json',
                ])
            ).stdout,
        );
        this.state = {
            tag: this.config.tag,
            gateway: this.config.tag + '-gateway',
            image: this.config.tag + '-runtime',
            productionImage: this.config.tag + '-runtime-base',
            configHash: hash(original),
            baseline: baseline.sandboxes.map((x) => x.id).sort(),
            sandboxes: [],
        };
        await this.save();
        const runtime = join(this.root, 'runtime');
        const hashes = await buildRuntime(
            runtime,
            this.state.image,
            this.config.nodeImage,
        );
        const gatewayState = join(this.root, 'gateway-state');
        await mkdir(gatewayState, { mode: 0o700 });
        await command([
            'docker',
            'run',
            '--rm',
            '--user',
            '0',
            '-v',
            gatewayState + ':' + gatewayState,
            'ghcr.io/nvidia/openshell/gateway:0.1.6',
            'generate-certs',
            '--output-dir',
            join(gatewayState, 'tls'),
        ]);
        let gateway = original
            .toString()
            .replaceAll(join(this.base, 'state'), gatewayState)
            .replaceAll('18080', '18180')
            .replaceAll('18081', '18181')
            .replaceAll('18082', '18182')
            .replace(
                /gateway_id\s*=\s*"openshell-docker"/,
                'gateway_id = "' + this.state.tag + '"',
            )
            .replace(
                /sandbox_label\s*=\s*"openshell"/,
                'sandbox_label = "' + this.state.tag + '"',
            )
            .replace(
                '[openshell.drivers.docker]',
                '[openshell.drivers.docker]\nallow_driver_config = true',
            );
        assert(gateway.includes('gateway_id = "' + this.state.tag + '"'));
        assert(gateway.includes('sandbox_label = "' + this.state.tag + '"'));
        const configFile = join(this.root, 'gateway.toml');
        await writeFile(configFile, gateway);
        await command([
            'docker',
            'run',
            '-d',
            '--user',
            '0',
            '--name',
            this.state.gateway,
            '--network',
            'host',
            '-e',
            'OPENSHELL_GATEWAY_CONFIG=/etc/openshell/gateway.toml',
            '-e',
            'OPENSHELL_DB_URL=sqlite:' + gatewayState + '/gateway.db?mode=rwc',
            '-e',
            'XDG_DATA_HOME=' + gatewayState,
            '-e',
            'HOME=' + gatewayState,
            '-v',
            configFile + ':/etc/openshell/gateway.toml:ro',
            '-v',
            gatewayState + ':' + gatewayState,
            '-v',
            '/var/run/docker.sock:/var/run/docker.sock',
            'ghcr.io/nvidia/openshell/gateway:0.1.6',
            '--bind-address',
            '127.0.0.1',
            '--port',
            '18180',
        ]);
        for (let attempt = 0; ; attempt++) {
            if (
                (
                    await this.cli(['sandbox', 'list', '-o', 'json'], {
                        allowFailure: true,
                    })
                ).code === 0
            )
                break;
            assert(attempt < 40, 'gateway readiness timeout');
            await delay(300);
        }
        if (this.config.mtlsOnly) {
            this.state.prepared = {
                sandboxes: [],
                helper_path: hashes.helperPath,
            };
            await this.save();
            return this.state.prepared;
        }
        const policy = await readFile(
            join(this.root, 'fixtures/sandbox/policy.yaml'),
            'utf8',
        );
        await writeFile(join(this.root, 'policy.yaml'), policy);
        const sandboxes = [];
        for (let i = 0; i < 3; i++) {
            const name = this.config.tag + '-' + String.fromCharCode(97 + i);
            this.state.pending = name;
            await this.save();
            const start = `mkdir -p /sandbox/project; printf %s ONLY-${i} > /sandbox/identity; exec sleep infinity`;
            if (i === 2) {
                const credentials = join(this.root, 'deploy-credentials');
                await mkdir(credentials, { mode: 0o700 });
                const env = {
                    ...process.env,
                    COMPOSE_PROJECT_NAME: this.state.tag,
                    DSH_OPENSHELL_RUNTIME_IMAGE: this.state.productionImage,
                    DSH_OPENSHELL_NODE_IMAGE: this.config.nodeImage ?? '',
                    DSH_OPENSHELL_BUILD_NETWORK: 'host',
                    DSH_OPENSHELL_GATEWAY_ENDPOINT: this.endpoint,
                    DSH_OPENSHELL_SANDBOX: name,
                    DSH_OPENSHELL_CLI_PATH: this.cliPath,
                    DSH_OPENSHELL_CREDENTIALS_DIR: credentials,
                };
                const composeRoot = join(this.root, 'image');
                await writeFile(
                    join(composeRoot, '.env'),
                    'COMPOSE_FILE=deploy/compose.yaml\n',
                    { mode: 0o600 },
                );
                const compose = ['docker', 'compose'];
                this.state.compose = true;
                await this.save();
                let originalId;
                for (let run = 0; run < 2; run++) {
                    await command(
                        run === 0
                            ? [...compose, 'up', '-d']
                            : ['node', join(composeRoot, 'deploy/deploy.mjs')],
                        {
                            cwd: composeRoot,
                            env,
                            timeout: 240000,
                        },
                    );
                    const ids = (
                        await command(
                            [...compose, 'ps', '-a', '-q', 'runtime'],
                            { cwd: composeRoot, env },
                        )
                    ).stdout.trim();
                    assert(ids, 'Compose did not create deployment container');
                    const waited = await command(['docker', 'wait', ids], {
                        timeout: 150000,
                    });
                    const logs = (await command(['docker', 'logs', ids]))
                        .stdout;
                    assert.equal(waited.stdout.trim(), '0', logs);
                    assert.match(logs, /"status":"READY"/);
                    const current = await this.facts(name);
                    assert.equal(String(current.phase).toLowerCase(), 'ready');
                    if (originalId)
                        assert.equal(
                            current.id,
                            originalId,
                            'Repeat up must preserve sandbox',
                        );
                    originalId = current.id;
                }
            } else {
                await this.cli([
                    'sandbox',
                    'create',
                    '--name',
                    name,
                    '--from',
                    i === 2 ? this.state.productionImage : this.state.image,
                    '--policy',
                    join(this.root, 'policy.yaml'),
                    '--detach',
                    ...(i === 2 ? [] : ['--', '/bin/sh', '-ec', start]),
                ]);
            }
            const facts = await this.facts(name);
            this.state.sandboxes.push({ name, id: facts.id });
            delete this.state.pending;
            await this.save();
            sandboxes.push({ name, id: facts.id });
        }
        const image = JSON.parse(
            (await command(['docker', 'image', 'inspect', this.state.image]))
                .stdout,
        )[0];
        this.state.prepared = {
            sandboxes,
            image_id: image.Id,
            helper_path: hashes.helperPath,
            runtime_sandbox: sandboxes[2],
        };
        await this.save();
        return this.state.prepared;
    }
    async deleteSandboxes() {
        const names = [
            ...this.state.sandboxes.map((x) => x.name),
            this.state.pending,
        ].filter(Boolean);
        for (const name of names) {
            const current = await this.cli(
                ['sandbox', 'get', name, '-o', 'json'],
                { allowFailure: true },
            );
            if (current.code === 0) await this.cli(['sandbox', 'delete', name]);
            for (let attempt = 0; ; attempt++) {
                const next = await this.cli(
                    ['sandbox', 'get', name, '-o', 'json'],
                    { allowFailure: true },
                );
                if (
                    next.code !== 0 &&
                    /not found/i.test(next.stdout + next.stderr)
                )
                    break;
                assert(attempt < 80, 'sandbox deletion unconfirmed');
                await delay(300);
            }
        }
        this.state.sandboxes = [];
        delete this.state.pending;
        await this.save();
    }
    async cleanup() {
        if (!this.state) {
            try {
                this.state = JSON.parse(await readFile(this.statePath, 'utf8'));
            } catch (error) {
                if (error.code === 'ENOENT') return { status: 'NO_STATE' };
                throw error;
            }
        }
        if (this.state.compose) {
            await command(
                [
                    'docker',
                    'compose',
                    '-p',
                    this.state.tag,
                    '-f',
                    join(this.root, 'image/deploy/compose.yaml'),
                    'down',
                ],
                {
                    env: {
                        ...process.env,
                        DSH_OPENSHELL_RUNTIME_IMAGE: this.state.productionImage,
                        DSH_OPENSHELL_CLI_PATH: this.cliPath,
                        DSH_OPENSHELL_CREDENTIALS_DIR: join(
                            this.root,
                            'deploy-credentials',
                        ),
                    },
                    allowFailure: true,
                },
            );
        }
        await this.deleteSandboxes();
        await command(['docker', 'rm', '-f', this.state.gateway], {
            allowFailure: true,
        });
        assert.equal(
            hash(await readFile(join(this.base, 'gateway.toml'))),
            this.state.configHash,
        );
        const baseline = JSON.parse(
            (
                await command([
                    this.cliPath,
                    '--gateway-endpoint',
                    'http://127.0.0.1:18080',
                    'sandbox',
                    'list',
                    '-o',
                    'json',
                ])
            ).stdout,
        );
        assert.deepEqual(
            baseline.sandboxes.map((x) => x.id).sort(),
            this.state.baseline,
        );
        const remaining = (
            await command(['docker', 'ps', '-a', '--format', '{{.Names}}'])
        ).stdout
            .split('\n')
            .filter((name) => name.startsWith(this.config.tag));
        assert.deepEqual(remaining, []);
        const gatewayState = join(this.root, 'gateway-state');
        let gatewayStateExists = true;
        try {
            await access(gatewayState);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            gatewayStateExists = false;
        }
        if (gatewayStateExists) {
            await command([
                'docker',
                'run',
                '--rm',
                '--user',
                '0',
                '--network',
                'none',
                '-v',
                gatewayState + ':/cleanup',
                '--entrypoint',
                '/bin/sh',
                this.state.productionImage,
                '-ec',
                'find /cleanup -mindepth 1 -delete',
            ]);
            await rm(gatewayState, { recursive: true, force: true });
        }
        for (const image of [this.state.image, this.state.productionImage])
            await command(['docker', 'image', 'rm', image], {
                allowFailure: true,
            });
        return {
            status: 'PASS',
            original_gateway_config_unchanged: true,
            original_sandbox_inventory_unchanged: true,
            remaining_test_containers: [],
        };
    }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
    const [action, root] = process.argv.slice(2);
    const config = JSON.parse(
        await readFile(join(root, 'fixture.json'), 'utf8'),
    );
    const host = new SandboxHost(root, config);
    if (action !== 'prepare')
        host.state = JSON.parse(await readFile(host.statePath, 'utf8'));
    let result;
    if (action === 'prepare') result = await host.prepare();
    else if (action === 'cleanup') result = await host.cleanup();
    else if (action === 'mtls')
        result = await (await import('../deploy/mtls.mjs')).verifyMtls(host);
    else throw new Error('unknown host action');
    process.stdout.write(JSON.stringify(result) + '\n');
}
