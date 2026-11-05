import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { command, shell } from '../support/process.mjs';

export class Connection {
    constructor(host, socket, env) {
        this.host = host;
        this.socket = socket;
        this.env = env;
    }
    argv() {
        return ['ssh', '-S', this.socket, '-o', 'BatchMode=yes', this.host];
    }
    run(argv, options = {}) {
        return command([...this.argv(), shell(argv)], {
            env: this.env,
            ...options,
        });
    }
    async copy(paths, destination, recursive = false) {
        await command(
            [
                'scp',
                '-q',
                ...(recursive ? ['-r'] : []),
                '-o',
                'ControlPath=' + this.socket,
                ...paths,
                this.host + ':' + destination,
            ],
            { env: this.env, timeout: 60000 },
        );
    }
}

export async function withConnection(callback) {
    const env = { ...process.env };
    const host = env.DSH_OPENSHELL_SSH_HOST || '';
    const password = env.DSH_OPENSHELL_SSH_PASSWORD || '';
    delete env.DSH_OPENSHELL_SSH_HOST;
    delete env.DSH_OPENSHELL_SSH_PASSWORD;
    if (env.DSH_OPENSHELL_CONNECTION) {
        const config = JSON.parse(
            await readFile(env.DSH_OPENSHELL_CONNECTION, 'utf8'),
        );
        assert(
            typeof config.host === 'string' &&
                !config.host.startsWith('-') &&
                !/\s/.test(config.host),
        );
        const connection = new Connection(config.host, config.socket, env);
        return callback(connection);
    }
    assert(
        host && !host.startsWith('-') && !/\s/.test(host),
        'Configure the private SSH destination in .env',
    );
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-'));
    await chmod(root, 0o700);
    const socket = join(root, 'master');
    const sshEnv = { ...env };
    if (password) {
        await writeFile(join(root, 'password'), password + '\n', {
            mode: 0o600,
        });
        await writeFile(
            join(root, 'askpass'),
            '#!/bin/sh\nexec cat "${0%/*}/password"\n',
            { mode: 0o700 },
        );
        Object.assign(sshEnv, {
            SSH_ASKPASS: join(root, 'askpass'),
            SSH_ASKPASS_REQUIRE: 'force',
        });
    }
    const connection = new Connection(host, socket, env);
    try {
        await command(
            [
                'ssh',
                '-S',
                socket,
                '-o',
                'StrictHostKeyChecking=yes',
                '-o',
                'ConnectTimeout=8',
                '-o',
                'BatchMode=' + (password ? 'no' : 'yes'),
                '-MNf',
                host,
            ],
            { env: sshEnv, timeout: 30000 },
        );
        await rm(join(root, 'password'), { force: true });
        await rm(join(root, 'askpass'), { force: true });
        return await callback(connection);
    } finally {
        await command(['ssh', '-S', socket, '-O', 'exit', host], {
            env,
            allowFailure: true,
        });
        await rm(root, { recursive: true, force: true });
    }
}
