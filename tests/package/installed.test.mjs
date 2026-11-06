import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { consumerTypes } from '../fixtures/package/types.mjs';
const repo = resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
const output = join(repo, 'runtime/releases', manifest.version);
await mkdir(output, { recursive: true });
execFileSync(process.execPath, [join(repo, 'scripts/build.mjs')], {
    cwd: repo,
    stdio: 'inherit',
});
const packed = JSON.parse(
    execFileSync(
        'npm',
        ['pack', '--ignore-scripts', '--json', '--pack-destination', output],
        { cwd: repo, encoding: 'utf8' },
    ),
)[0];
const tarball = join(output, packed.filename);
const files = packed.files.map((file) => file.path);
try {
    process.loadEnvFile(join(repo, '.env'));
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
const privateValues = [
    'DSH_OPENSHELL_SSH_HOST',
    'DSH_OPENSHELL_SSH_PASSWORD',
    'DSH_OPENSHELL_REMOTE_HOME',
    'DSH_OPENSHELL_CONNECTION',
    'DSH_OPENSHELL_CLI_PATH',
    'DSH_OPENSHELL_CREDENTIALS_DIR',
]
    .map((key) => process.env[key])
    .filter((value) => value && value.length > 8);
for (const file of files) {
    assert(
        /^(dist\/|docs\/|README\.md$|package\.json$)/.test(file),
        'Unexpected package file: ' + file,
    );
    assert(
        !/(^|\/)(?:node_modules|\.git|\.env(?:\..*)?)($|\/)/.test(file),
        'Private file: ' + file,
    );
    assert(
        !/\.(?:pem|key|crt|tgz|log)$/.test(file),
        'Credential or artifact file: ' + file,
    );
    const content = await readFile(join(repo, file), 'utf8');
    assert(
        !privateValues.some((value) => content.includes(value)),
        'Private configuration in package: ' + file,
    );
    assert(
        !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content),
        'Private key: ' + file,
    );
}
assert(files.includes('dist/index.js') && files.includes('dist/index.d.ts'));
assert(
    files.includes('dist/runtime/confine.mjs') &&
        files.includes('dist/runtime/fs.mjs'),
);
assert.equal(manifest.dependencies['@deepseek-ai/cordis'], '4.0.5');
for (const [name, version] of Object.entries(manifest.dependencies))
    if (name.startsWith('@deepseek-ai/dsh-'))
        assert.equal(version, '0.2.1-rc.4');
const consumer = join(output, 'consumer');
await rm(consumer, { recursive: true, force: true });
await mkdir(consumer);
await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
);
execFileSync(
    'npm',
    [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--save-exact',
        tarball,
        '@types/node@22.20.5',
    ],
    { cwd: consumer, stdio: 'inherit' },
);
await copyFile(
    join(repo, 'tests/fixtures/package/consumer.mjs'),
    join(consumer, 'smoke.mjs'),
);
execFileSync(process.execPath, ['smoke.mjs', manifest.version], {
    cwd: consumer,
    stdio: 'inherit',
});
await writeFile(join(consumer, 'consumer.ts'), consumerTypes);
await writeFile(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
        compilerOptions: {
            noEmit: true,
            strict: true,
            skipLibCheck: false,
            module: 'NodeNext',
            target: 'ES2023',
            types: ['node'],
        },
        include: ['consumer.ts'],
    }),
);
execFileSync(
    process.execPath,
    [
        join(repo, 'node_modules/typescript/bin/tsc'),
        '--project',
        join(consumer, 'tsconfig.json'),
    ],
    { cwd: consumer, stdio: 'inherit' },
);

const report = {
    name: manifest.name,
    version: manifest.version,
    tag: 'rc',
    tarball,
    integrity: packed.integrity,
    sha256: createHash('sha256')
        .update(await readFile(tarball))
        .digest('hex'),
    fileCount: files.length,
    bytes: packed.size,
    validation: 'PASS',
};
await writeFile(
    join(output, 'verification.json'),
    JSON.stringify(report, null, 2) + '\n',
);
await writeFile(
    join(output, 'pack.json'),
    JSON.stringify([packed], null, 2) + '\n',
);
console.log(JSON.stringify(report));
