import assert from 'node:assert/strict';
import process from 'node:process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { command, delay } from '../support/process.mjs';

/** Upgrade only the disposable test Gateway after HTTP provider tests finish. */
async function runMtls(host) {
    await host.deleteSandboxes();
    const root = host.root;
    const state = join(root, 'gateway-state');
    const tls = join(state, 'tls');
    const credentials = join(root, 'mtls-credentials');
    const clientHome = join(root, 'mtls-config');
    const clientFiles = join(clientHome, 'openshell/gateways/deployment/mtls');
    for (const directory of [credentials, clientFiles])
        await mkdir(directory, { recursive: true, mode: 0o700 });
    await copyOwned(host, [
        ['gateway-state/tls/ca.crt', 'mtls-credentials/ca.crt'],
        ['gateway-state/tls/client/tls.crt', 'mtls-credentials/tls.crt'],
        ['gateway-state/tls/client/tls.key', 'mtls-credentials/tls.key'],
        [
            'gateway-state/tls/ca.crt',
            'mtls-config/openshell/gateways/deployment/mtls/ca.crt',
        ],
        [
            'gateway-state/tls/client/tls.crt',
            'mtls-config/openshell/gateways/deployment/mtls/tls.crt',
        ],
        [
            'gateway-state/tls/client/tls.key',
            'mtls-config/openshell/gateways/deployment/mtls/tls.key',
        ],
    ]);
    let config = await readFile(join(root, 'gateway.toml'), 'utf8');
    await writeFile(join(root, 'gateway-http.toml'), config, { mode: 0o600 });
    config = config
        .replace(/disable_tls\s*=\s*true/g, 'disable_tls = false')
        .replace(
            /allow_unauthenticated_users\s*=\s*true/g,
            'allow_unauthenticated_users = false',
        );
    const guestCA = 'guest_tls_ca = ' + JSON.stringify(join(tls, 'ca.crt'));
    config = /^\s*guest_tls_ca\s*=/m.test(config)
        ? config.replace(/^\s*guest_tls_ca\s*=.*$/m, guestCA)
        : config.replace(
              '[openshell.gateway]',
              '[openshell.gateway]\n' + guestCA,
          );
    assert(
        config.includes(guestCA),
        'mTLS Docker Gateway requires guest TLS CA',
    );
    assert(
        config.includes('allow_unauthenticated_users = false'),
        'Test Gateway must reject anonymous users',
    );
    await command(['docker', 'rm', '-f', host.state.gateway]);
    await writeFile(join(root, 'gateway.toml'), config);
    host.state.mtls = true;
    await host.save();
    await command(
        gatewayCommand(host, [
            '--tls-cert',
            join(tls, 'server/tls.crt'),
            '--tls-key',
            join(tls, 'server/tls.key'),
            '--tls-client-ca',
            join(tls, 'ca.crt'),
            '--enable-mtls-auth',
            'true',
            '--enable-operator-auth',
            'false',
        ]),
    );
    for (let attempt = 0; ; attempt++) {
        if (
            (
                await host.cli(['sandbox', 'list', '-o', 'json'], {
                    allowFailure: true,
                })
            ).code === 0
        )
            break;
        const running = (
            await command([
                'docker',
                'inspect',
                '--format',
                '{{.State.Running}}',
                host.state.gateway,
            ])
        ).stdout.trim();
        if (attempt >= 40 || running !== 'true')
            throw new Error(
                'mTLS Gateway readiness failed: ' +
                    (
                        await command(['docker', 'logs', host.state.gateway])
                    ).stderr.slice(-2000),
            );
        await delay(300);
    }
    host.state.mtlsReady = true;
    await host.save();
    const foreign = join(state, 'foreign');
    await command([
        'docker',
        'run',
        '--rm',
        '--user',
        '0',
        '-v',
        state + ':' + state,
        'ghcr.io/nvidia/openshell/gateway:0.1.6',
        'generate-certs',
        '--output-dir',
        foreign,
    ]);
    const wrong = join(root, 'mtls-wrong-client');
    await mkdir(wrong, { mode: 0o700 });
    await copyOwned(host, [
        ['gateway-state/tls/ca.crt', 'mtls-wrong-client/ca.crt'],
        ['gateway-state/foreign/client/tls.crt', 'mtls-wrong-client/tls.crt'],
        ['gateway-state/foreign/client/tls.key', 'mtls-wrong-client/tls.key'],
    ]);
    await command(
        ['node', join(root, 'client/tests/e2e/mtls.test.mjs'), root],
        { timeout: 30000 },
    );
    const name = host.state.tag + '-m';
    host.state.pending = name;
    host.state.compose = true;
    await host.save();
    const env = {
        ...process.env,
        COMPOSE_PROJECT_NAME: host.state.tag,
        DSH_OPENSHELL_RUNTIME_IMAGE: host.state.productionImage,
        DSH_OPENSHELL_NODE_IMAGE: host.config.nodeImage ?? '',
        DSH_OPENSHELL_BUILD_NETWORK: 'host',
        DSH_OPENSHELL_GATEWAY_ENDPOINT: 'https://127.0.0.1:18180',
        DSH_OPENSHELL_SANDBOX: name,
        DSH_OPENSHELL_CLI_PATH: host.cliPath,
        DSH_OPENSHELL_CREDENTIALS_DIR: credentials,
    };
    const composeRoot = join(root, 'image');
    await writeFile(
        join(composeRoot, '.env'),
        'COMPOSE_FILE=deploy/compose.yaml\n',
        { mode: 0o600 },
    );
    const policyPath = join(composeRoot, 'deploy/openshell/policy.yaml');
    const originalPolicy = await readFile(policyPath, 'utf8');
    const runCompose = async () => {
        await command(['node', join(composeRoot, 'deploy/deploy.mjs')], {
            cwd: composeRoot,
            env,
            timeout: 240000,
        });
        const id = (
            await command(['docker', 'compose', 'ps', '-a', '-q', 'runtime'], {
                cwd: composeRoot,
                env,
            })
        ).stdout.trim();
        const exited = await command(['docker', 'wait', id], {
            timeout: 150000,
        });
        const output = await command(['docker', 'logs', id]);
        const logs = output.stdout;
        assert.equal(exited.stdout.trim(), '0', logs + output.stderr);
        const result = JSON.parse(logs.trim().split(/\r?\n/).at(-1));
        assert.equal(result.status, 'READY');
        return {
            ...(await host.facts(name)),
            deploymentCreated: result.created,
        };
    };
    try {
        const created = await runCompose();
        assert.equal(created.deploymentCreated, true);
        host.state.sandboxes.push({ name, id: created.id });
        delete host.state.pending;
        await host.save();
        const repeated = await runCompose();
        assert.equal(repeated.id, created.id);
        assert.equal(repeated.deploymentCreated, false);
        const before = await host.facts(name);
        const updated = originalPolicy.replace(
            'network_policies: {}',
            `network_policies:
    deployment_probe:
        name: deployment-probe
        endpoints:
            - host: deployment.invalid
              port: 443
              protocol: tcp
        binaries:
            - path: /usr/local/bin/node`,
        );
        assert.notEqual(updated, originalPolicy);
        await writeFile(policyPath, updated);
        const after = await runCompose();
        assert.equal(after.id, created.id);
        assert.equal(after.deploymentCreated, false);
        assert.equal(String(after.phase).toLowerCase(), 'ready');
        assert(
            Number(after.current_policy_version) >
                Number(before.current_policy_version),
            'Loaded policy revision must increase',
        );
        assert.equal(
            after.policy.network_policies.deployment_probe.endpoints[0].host,
            'deployment.invalid',
        );
        return {
            status: 'PASS',
            first_create: true,
            repeated_up_same_sandbox: true,
            policy_update_loaded: true,
            policy_revision_before: Number(before.current_policy_version),
            policy_revision_after: Number(after.current_policy_version),
            no_client_certificate_denied: true,
            untrusted_client_certificate_denied: true,
        };
    } finally {
        await writeFile(policyPath, originalPolicy);
    }
}

async function copyOwned(host, files) {
    const script = `const fs=require('node:fs');for(const [source,target] of JSON.parse(process.argv[1])){const dest='/fixture/'+target;fs.copyFileSync('/fixture/'+source,dest);fs.chmodSync(dest,0o600);fs.chownSync(dest,Number(process.argv[2]),Number(process.argv[3]));}`;
    await command([
        'docker',
        'run',
        '--rm',
        '--network',
        'none',
        '--user',
        '0',
        '-v',
        host.root + ':/fixture',
        '--entrypoint',
        '/usr/local/bin/node',
        host.state.productionImage,
        '-e',
        script,
        JSON.stringify(files),
        String(process.getuid()),
        String(process.getgid()),
    ]);
}
function gatewayCommand(host, extra = []) {
    const state = join(host.root, 'gateway-state');
    return [
        'docker',
        'run',
        '-d',
        '--user',
        '0',
        '--name',
        host.state.gateway,
        '--network',
        'host',
        '-e',
        'OPENSHELL_GATEWAY_CONFIG=/etc/openshell/gateway.toml',
        '-e',
        'OPENSHELL_DB_URL=sqlite:' + state + '/gateway.db?mode=rwc',
        '-e',
        'XDG_DATA_HOME=' + state,
        '-e',
        'HOME=' + state,
        '-v',
        join(host.root, 'gateway.toml') + ':/etc/openshell/gateway.toml:ro',
        '-v',
        state + ':' + state,
        '-v',
        '/var/run/docker.sock:/var/run/docker.sock',
        'ghcr.io/nvidia/openshell/gateway:0.1.6',
        '--bind-address',
        '127.0.0.1',
        '--port',
        '18180',
        ...extra,
    ];
}
export async function verifyMtls(host) {
    try {
        return await runMtls(host);
    } catch (error) {
        await writeFile(
            join(host.root, 'mtls-failure.txt'),
            error.stack ?? error.message,
            { mode: 0o600 },
        );
        if (host.state.mtls && !host.state.mtlsReady) {
            await command(['docker', 'rm', '-f', host.state.gateway], {
                allowFailure: true,
            });
            await writeFile(
                join(host.root, 'gateway.toml'),
                await readFile(join(host.root, 'gateway-http.toml')),
            );
            host.state.mtls = false;
            await host.save();
            await command(gatewayCommand(host));
            for (let attempt = 0; ; attempt++) {
                if (
                    (
                        await host.cli(['sandbox', 'list', '-o', 'json'], {
                            allowFailure: true,
                        })
                    ).code === 0
                )
                    break;
                assert(attempt < 40, 'HTTP cleanup recovery failed');
                await delay(300);
            }
        }
        throw error;
    }
}
