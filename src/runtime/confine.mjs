import { Buffer } from 'node:buffer';
// Installed in the sandbox image beside version-locked dependencies.
import process from 'node:process';
import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local';
const require = createRequire(import.meta.url);
const version = require('@deepseek-ai/dsh-sandbox-local/package.json').version;
if (version !== '0.2.1-rc.4')
    throw new Error('sandbox helper version mismatch');
const raw = Buffer.from(process.argv[2] ?? '', 'base64');
if (raw.length > 65536) throw new Error('confinement request too large');
const { argv, policy } = JSON.parse(raw.toString());
if (
    !Array.isArray(argv) ||
    !argv.length ||
    !argv.every((v) => typeof v === 'string' && !v.includes('\0')) ||
    !policy ||
    !['read-only', 'workspace-write'].includes(policy.mode) ||
    typeof policy.workspaceRoot !== 'string' ||
    !policy.workspaceRoot.startsWith('/')
)
    throw new Error('invalid confinement request');
const ctx = new Context();
try {
    await ctx.plugin(LocalSandboxProvider);
    const wrapped = await ctx.sandbox.confine(argv, policy);
    process.stdout.write(JSON.stringify({ ...wrapped, version }) + '\n');
} finally {
    await ctx.fiber.dispose();
}
