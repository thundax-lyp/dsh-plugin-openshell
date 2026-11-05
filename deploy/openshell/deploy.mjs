import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, copyFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { URL, pathToFileURL } from 'node:url';

/** One-shot deployment using only official CLI operations; no daemon or controller. */
export async function deploy(config, run) {
    const { name, image, policy, timeout = 120 } = config;
    if (
        typeof name !== 'string' ||
        !/^[a-z0-9](?:[a-z0-9-]{0,17}[a-z0-9])?$/.test(name)
    )
        throw new Error(
            'Sandbox name must be a DNS label of 1..19 lowercase letters, digits or hyphens',
        );
    if (!image || !Number.isInteger(timeout) || timeout < 1 || timeout > 3600)
        throw new Error('Invalid deployment configuration');
    if (!(await run(['--version'])).trim().match(/^openshell 0\.1\.6(?:\s|$)/))
        throw new Error('OpenShell CLI 0.1.6 required');
    const imageKey = createHash('sha256')
        .update(image)
        .digest('hex')
        .slice(0, 32);
    const ownerKey = 'dsh-openshell';
    let existing, page;
    do {
        const result = JSON.parse(
            await run([
                'sandbox',
                'list',
                '-o',
                'json',
                ...(page ? ['--page-token', page] : []),
            ]),
        );
        if (!Array.isArray(result.sandboxes))
            throw new Error('Invalid sandbox list');
        existing = result.sandboxes.find((sandbox) => sandbox.name === name);
        page = result.next_page_token;
    } while (!existing && page);
    if (
        existing &&
        (existing.labels?.[ownerKey] !== 'compose' ||
            existing.labels?.['dsh-runtime'] !== imageKey)
    )
        throw new Error(
            'Existing sandbox ownership or image reference differs; use a new name or reconcile explicitly',
        );
    if (!existing)
        await run([
            'sandbox',
            'create',
            '--name',
            name,
            '--from',
            image,
            '--policy',
            policy,
            '--detach',
            '--no-auto-providers',
            '--label',
            `${ownerKey}=compose`,
            '--label',
            `dsh-runtime=${imageKey}`,
        ]);
    const deadline = Date.now() + timeout * 1000;
    let facts;
    for (;;) {
        facts = JSON.parse(await run(['sandbox', 'get', name, '-o', 'json']));
        const phase = String(facts.phase).toLowerCase();
        if (phase === 'ready') break;
        if (
            ['failed', 'terminated', 'completed', 'stopped', 'error'].includes(
                phase,
            )
        )
            throw new Error('Sandbox is not runnable: ' + phase);
        if (Date.now() >= deadline) throw new Error('Sandbox READY timeout');
        await delay(300);
    }
    await run([
        'policy',
        'set',
        name,
        '--policy',
        policy,
        '--wait',
        '--timeout',
        String(timeout),
    ]);
    facts = JSON.parse(await run(['sandbox', 'get', name, '-o', 'json']));
    if (String(facts.phase).toLowerCase() !== 'ready')
        throw new Error('Sandbox left READY during deployment');
    return { status: 'READY', id: facts.id, name, created: !existing };
}

async function main() {
    process.umask(0o077);
    const configHome = '/tmp/openshell-config';
    const mtls = configHome + '/openshell/gateways/deployment/mtls';
    const source = '/run/openshell-credentials';
    const certs = ['ca.crt', 'tls.crt', 'tls.key'];
    const present = await Promise.all(
        certs.map((file) =>
            access(source + '/' + file).then(
                () => true,
                () => false,
            ),
        ),
    );
    if (present.some(Boolean)) {
        if (!present.every(Boolean))
            throw new Error('mTLS requires ca.crt, tls.crt and tls.key');
        await mkdir(mtls, { recursive: true, mode: 0o700 });
        for (const file of certs)
            await copyFile(source + '/' + file, mtls + '/' + file);
    }
    const endpoint = process.env.DSH_OPENSHELL_GATEWAY_ENDPOINT;
    if (!endpoint || !['http:', 'https:'].includes(new URL(endpoint).protocol))
        throw new Error('Explicit HTTP(S) Gateway endpoint required');
    const timeout = Number(process.env.DSH_OPENSHELL_DEPLOY_TIMEOUT ?? 120);
    const budget = globalThis.AbortSignal.timeout(timeout * 1000);
    const execute = promisify(execFile);
    const run = async (args) => {
        const result = await execute(
            '/usr/local/bin/openshell',
            [
                '--gateway',
                'deployment',
                '--gateway-endpoint',
                endpoint,
                '--workspace',
                process.env.DSH_OPENSHELL_WORKSPACE ?? 'default',
                ...args,
            ],
            {
                env: {
                    ...process.env,
                    XDG_CONFIG_HOME: configHome,
                    HOME: '/tmp',
                },
                signal: budget,
                maxBuffer: 1024 * 1024,
            },
        );
        return result.stdout;
    };
    const result = await deploy(
        {
            name: process.env.DSH_OPENSHELL_SANDBOX,
            image: process.env.DSH_OPENSHELL_RUNTIME_IMAGE,
            policy: '/run/deploy/policy.yaml',
            timeout,
        },
        run,
    );
    process.stdout.write(JSON.stringify(result) + '\n');
}
if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    main().catch((error) => {
        process.stderr.write('Deployment failed: ' + error.message + '\n');
        process.exitCode = 1;
    });
}
