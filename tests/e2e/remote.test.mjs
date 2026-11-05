import console from 'node:console';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, copyFile, rm } from 'node:fs/promises';
import { join, resolve, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { withConnection } from '../fixtures/host/connection.mjs';
const repo = resolve(import.meta.dirname, '../..');
try {
    process.loadEnvFile(join(repo, '.env'));
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
const root = await mkdtemp(join(tmpdir(), 'dsh-os-rc-'));
const tag = basename(root).toLowerCase();
const remote = '/tmp/' + tag;
try {
    await withConnection(async (c) => {
        const bundle = join(root, 'bundle');
        await mkdir(join(bundle, 'fixtures'), { recursive: true });
        for (const file of [
            'sandbox/host.mjs',
            'deploy/mtls.mjs',
            'runtime/build.mjs',
            'support/process.mjs',
        ]) {
            await mkdir(dirname(join(bundle, 'fixtures', file)), {
                recursive: true,
            });
            await copyFile(
                join(repo, 'tests/fixtures', file),
                join(bundle, 'fixtures', file),
            );
        }
        await mkdir(join(bundle, 'image/src/runtime'), { recursive: true });
        await mkdir(join(bundle, 'runtime'), { recursive: true });
        await mkdir(join(bundle, 'image/deploy/runtime'), { recursive: true });
        await copyFile(
            join(repo, 'deploy/compose.yaml'),
            join(bundle, 'image/deploy/compose.yaml'),
        );
        for (const file of ['Dockerfile', 'Dockerfile.dockerignore'])
            await copyFile(
                join(repo, 'deploy/runtime', file),
                join(bundle, 'image/deploy/runtime', file),
            );
        await cp(
            join(repo, 'deploy/openshell'),
            join(bundle, 'image/deploy/openshell'),
            { recursive: true },
        );
        await copyFile(
            join(repo, 'deploy/openshell/policy.yaml'),
            join(bundle, 'fixtures/sandbox/policy.yaml'),
        );
        for (const file of [
            'package.json',
            'package-lock.json',
            'confine.mjs',
            'fs.mjs',
        ])
            await copyFile(
                join(repo, 'src/runtime', file),
                join(bundle, 'image/src/runtime', file),
            );
        await copyFile(
            join(repo, 'tests/fixtures/sandbox/diagnostics.mjs'),
            join(bundle, 'runtime/diagnostics.mjs'),
        );
        for (const file of ['Dockerfile', 'Dockerfile.dockerignore'])
            await copyFile(
                join(repo, 'deploy/diagnostics', file),
                join(bundle, 'runtime', file),
            );
        await writeFile(
            join(bundle, 'fixture.json'),
            JSON.stringify({
                tag,
                mtlsOnly: process.argv.includes('--mtls-only'),
                nodeImage: process.env.DSH_OPENSHELL_NODE_IMAGE || undefined,
                remoteHome:
                    process.env.DSH_OPENSHELL_REMOTE_HOME || 'openshell',
            }),
        );
        await mkdir(join(bundle, 'client'), { recursive: true });
        for (const file of ['package.json', 'package-lock.json'])
            await copyFile(
                join(repo, 'tests/fixtures/runtime/client', file),
                join(bundle, 'client', file),
            );
        await cp(join(repo, 'src'), join(bundle, 'client/src'), {
            recursive: true,
        });
        await mkdir(join(bundle, 'client/tests/e2e'), { recursive: true });
        const scenarios = [
            { file: 'image.test.mjs', timeout: 60000 },
            { file: 'provider.test.mjs', timeout: 120000 },
            { file: 'fs.test.mjs', timeout: 120000 },
            { file: 'cancellation.test.mjs', timeout: 120000 },
        ];
        for (const { file } of [...scenarios, { file: 'mtls.test.mjs' }])
            await copyFile(
                join(repo, 'tests/e2e', file),
                join(bundle, 'client/tests/e2e', file),
            );
        await cp(
            join(repo, 'runtime/openshell-source/sdk/typescript/dist'),
            join(bundle, 'client/sdk/dist'),
            { recursive: true },
        );
        await c.run(['mkdir', '-m', '700', remote]);
        await c.copy([bundle + '/.'], remote + '/', true);
        const host = async (action) =>
            JSON.parse(
                (
                    await c.run(
                        [
                            'node',
                            remote + '/fixtures/sandbox/host.mjs',
                            action,
                            remote,
                        ],
                        { timeout: 360000 },
                    )
                ).stdout,
            );
        let primaryError, cleanupError;
        try {
            console.log(
                'Preparing isolated OpenShell fixture with RC sandbox dependencies',
            );
            const prepared = await host('prepare');
            await writeFile(
                join(root, 'prepared.json'),
                JSON.stringify(prepared),
            );
            await c.copy(
                [join(root, 'prepared.json')],
                remote + '/client/prepared.json',
            );
            await c.run(
                [
                    'npm',
                    'ci',
                    '--prefix',
                    remote + '/client',
                    '--ignore-scripts',
                    '--no-audit',
                    '--no-fund',
                ],
                { timeout: 120000 },
            );
            for (const { file, timeout } of process.argv.includes('--mtls-only')
                ? []
                : scenarios) {
                const result = await c.run(
                    [
                        'node',
                        '--experimental-strip-types',
                        remote + '/client/tests/e2e/' + file,
                        remote,
                    ],
                    { timeout },
                );
                console.log(result.stdout);
            }
            const mtls = await host('mtls');
            assert.equal(mtls.status, 'PASS');
            console.log(
                'PASS: mTLS Compose first creation, repeat reuse, loaded policy update ' +
                    mtls.policy_revision_before +
                    ' -> ' +
                    mtls.policy_revision_after +
                    ', and unauthenticated/untrusted client rejection',
            );
        } catch (error) {
            primaryError = error;
        } finally {
            try {
                const cleanup = await host('cleanup');
                assert.equal(cleanup.status, 'PASS');
                console.log(
                    'PASS: cleanup and original Gateway inventory unchanged',
                );
                await c.run(['rm', '-rf', remote]);
            } catch (error) {
                cleanupError = error;
            }
        }
        if (primaryError && cleanupError)
            throw new AggregateError(
                [primaryError, cleanupError],
                'Validation and cleanup failed',
                { cause: primaryError },
            );
        if (primaryError) throw primaryError;
        if (cleanupError) throw cleanupError;
    });
} finally {
    await rm(root, { recursive: true, force: true });
}
