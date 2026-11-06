import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import {
    access,
    chmod,
    mkdir,
    mkdtemp,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const checksum =
    '2951c67366f3e3584ed9cec8d49b9f0b0eefc8cacea8b0582ac164590492f136';
const url =
    'https://github.com/NVIDIA/OpenShell/releases/download/v0.1.6/openshell-x86_64-unknown-linux-musl.tar.gz';
const execute = promisify(execFile);
const run = async (command, args, options = {}) =>
    (
        await execute(command, args, {
            cwd: root,
            timeout: 600000,
            maxBuffer: 16 * 1024 * 1024,
            ...options,
        })
    ).stdout;

export async function prepareCli(
    path,
    {
        explicit = false,
        invoke = run,
        download = async () => {
            const response = await globalThis.fetch(url, {
                signal: globalThis.AbortSignal.timeout(120000),
            });
            if (!response.ok)
                throw new Error(`CLI download failed: ${response.status}`);
            return Buffer.from(await response.arrayBuffer());
        },
    } = {},
) {
    let exists = true;
    try {
        await access(path);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        exists = false;
    }
    if (!exists) {
        if (explicit) throw new Error('Configured CLI path does not exist');
        await mkdir(dirname(path), { recursive: true });
        const staging = await mkdtemp(resolve(dirname(path), '.openshell-'));
        try {
            let bytes;
            try {
                bytes = await download();
            } catch (error) {
                throw new Error(
                    'CLI download failed; check GitHub connectivity or set DSH_OPENSHELL_CLI_PATH to an existing official CLI',
                    { cause: error },
                );
            }
            if (createHash('sha256').update(bytes).digest('hex') !== checksum)
                throw new Error('Official CLI archive checksum mismatch');
            const archive = resolve(staging, 'cli.tar.gz');
            await writeFile(archive, bytes);
            await invoke('tar', ['-xzf', archive, '-C', staging, 'openshell']);
            const binary = resolve(staging, 'openshell');
            await chmod(binary, 0o755);
            if (
                !/^openshell 0\.1\.6(?:\s|$)/.test(
                    (await invoke(binary, ['--version'])).trim(),
                )
            )
                throw new Error('OpenShell CLI 0.1.6 required');
            await rename(binary, path);
        } finally {
            await rm(staging, { recursive: true, force: true });
        }
    }
    if (
        !/^openshell 0\.1\.6(?:\s|$)/.test(
            (await invoke(path, ['--version'])).trim(),
        )
    )
        throw new Error('OpenShell CLI 0.1.6 required');
}

export async function deployCompose(env, invoke = run) {
    const args = [
        'compose',
        '--env-file',
        resolve(root, '.env'),
        '-f',
        resolve(root, 'deploy/compose.yaml'),
    ];
    await invoke('docker', [...args, 'version'], { env });
    console.log('Building runtime image and starting deployment');
    await invoke('docker', [...args, 'up', '-d', 'runtime'], { env });
    const id = (
        await invoke('docker', [...args, 'ps', '-a', '-q', 'runtime'], { env })
    ).trim();
    if (!id || /\s/.test(id))
        throw new Error('Expected one deployment container');
    const code = (
        await invoke('docker', ['wait', id], {
            env,
            timeout:
                (Number(env.DSH_OPENSHELL_DEPLOY_TIMEOUT || 120) + 30) * 1000,
        })
    ).trim();
    const logs = await invoke(
        'docker',
        [...args, 'logs', '--no-color', 'runtime'],
        { env },
    );
    console.log(logs);
    if (code !== '0')
        throw new Error(`Deployment container exited with ${code}`);
    if (!/"status"\s*:\s*"READY"/.test(logs))
        throw new Error('Deployment did not report READY');
    console.log('Deployment READY');
}

async function main() {
    if (process.platform !== 'linux' || process.arch !== 'x64')
        throw new Error('Run deployment on the Linux x64 Gateway host');
    process.loadEnvFile(resolve(root, '.env'));
    const env = { ...process.env };
    const endpoint = new globalThis.URL(
        env.DSH_OPENSHELL_GATEWAY_ENDPOINT || 'http://127.0.0.1:18080',
    );
    if (!['http:', 'https:'].includes(endpoint.protocol))
        throw new Error('HTTP(S) Gateway endpoint required');
    const timeout = Number(env.DSH_OPENSHELL_DEPLOY_TIMEOUT || 120);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600)
        throw new Error('Invalid deployment timeout');
    const explicit = Boolean(env.DSH_OPENSHELL_CLI_PATH);
    if (explicit && !isAbsolute(env.DSH_OPENSHELL_CLI_PATH))
        throw new Error('CLI path must be absolute');
    env.DSH_OPENSHELL_CLI_PATH ||= resolve(root, 'runtime/bin/openshell');
    const credentials =
        env.DSH_OPENSHELL_CREDENTIALS_DIR ||
        resolve(root, 'runtime/openshell-credentials');
    if (!isAbsolute(credentials))
        throw new Error('Credentials path must be absolute');
    env.DSH_OPENSHELL_CREDENTIALS_DIR = credentials;
    if (endpoint.protocol === 'https:') {
        for (const file of ['ca.crt', 'tls.crt', 'tls.key'])
            await access(resolve(credentials, file));
    } else await mkdir(credentials, { recursive: true, mode: 0o700 });
    await prepareCli(env.DSH_OPENSHELL_CLI_PATH, { explicit });
    await deployCompose(env);
}
if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    main().catch((error) => {
        console.error('Deployment failed:', error.message);
        process.exitCode = 1;
    });
}
