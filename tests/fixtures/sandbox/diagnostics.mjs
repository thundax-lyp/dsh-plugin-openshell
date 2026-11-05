import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import {
    launcherPath,
    probe,
} from '@deepseek-ai/node-addon-system/landlock-run';
const require = createRequire(import.meta.url);
const run = (argv) => {
    const loader = '/opt/dsh-runtime/probes/lib/ld-linux-x86-64.so.2';
    const useHostLoader = argv[0].startsWith('/opt/dsh-runtime/probes/');
    const r = spawnSync(
        useHostLoader ? loader : argv[0],
        useHostLoader
            ? ['--library-path', '/opt/dsh-runtime/probes/lib', ...argv]
            : argv.slice(1),
        {
            encoding: 'utf8',
            timeout: 3000,
        },
    );
    return {
        code: r.status,
        signal: r.signal,
        stdout: r.stdout?.trim(),
        stderr: r.stderr?.trim(),
        error: r.error?.code,
    };
};
const status = readFileSync('/proc/self/status', 'utf8');
process.stdout.write(
    JSON.stringify({
        dsh: require('@deepseek-ai/dsh-sandbox-local/package.json').version,
        native: require('@deepseek-ai/node-addon-system/package.json').version,
        abi: JSON.parse(run(['/opt/dsh-runtime/probes/abi']).stdout),
        landlock: {
            verdict: probe(),
            result: run([launcherPath(), '--probe']),
        },
        bwrap: run([
            '/opt/dsh-runtime/probes/bin/bwrap',
            '--ro-bind',
            '/',
            '/',
            '--dev',
            '/dev',
            '--proc',
            '/proc',
            '--unshare-user',
            '--unshare-pid',
            '--die-with-parent',
            '--',
            'true',
        ]),
        unshare: run([
            '/opt/dsh-runtime/probes/bin/unshare',
            '--user',
            '--map-root-user',
            'true',
        ]),
        restrictions: Object.fromEntries(
            ['NoNewPrivs', 'Seccomp', 'CapEff'].map((key) => [
                key,
                status.match(new RegExp('^' + key + ':\\s*(.*)$', 'm'))?.[1],
            ]),
        ),
    }) + '\n',
);
