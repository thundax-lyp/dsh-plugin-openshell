import { spawn } from 'node:child_process';
import { setTimeout, clearTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';

export { delay };

export function quote(value) {
    return "'" + String(value).replaceAll("'", `'"'"'`) + "'";
}
export const shell = (argv) => argv.map(quote).join(' ');

export function start(argv, options = {}) {
    const child = spawn(argv[0], argv.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...options,
    });
    child.stdin.on('error', () => {});
    child.stderrText = '';
    child.stderr.on('data', (chunk) => {
        child.stderrText = (child.stderrText + chunk).slice(-12000);
    });
    child.completed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.completed.catch(() => {});
    return child;
}

export async function command(
    argv,
    { input, timeout = 60000, allowFailure = false, ...options } = {},
) {
    const child = start(argv, options);
    let stdout = '';
    child.stdout.on('data', (chunk) => {
        stdout += chunk;
    });
    child.stdin.end(input);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    let result;
    try {
        result = await child.completed;
    } finally {
        clearTimeout(timer);
    }
    const output = { ...result, stdout, stderr: child.stderrText };
    if (!allowFailure && result.code !== 0)
        throw new Error(
            'Command failed: ' + argv[0] + ' ' + child.stderrText.slice(-2500),
        );
    return output;
}
