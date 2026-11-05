import process from 'node:process';
import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { command } from '../support/process.mjs';
export async function buildRuntime(root, image, nodeImage) {
    assert((await command(['node', '--version'])).stdout.startsWith('v24.'));
    const productionImage = image + '-base';
    const compose = ['docker', 'compose', '-f', '../image/deploy/compose.yaml'];
    const env = {
        ...process.env,
        DSH_OPENSHELL_RUNTIME_IMAGE: productionImage,
        DSH_OPENSHELL_BUILD_NETWORK: 'host',
        ...(nodeImage ? { DSH_OPENSHELL_NODE_IMAGE: nodeImage } : {}),
    };
    const resolved = JSON.parse(
        (
            await command([...compose, 'config', '--format', 'json'], {
                cwd: root,
                env,
            })
        ).stdout,
    );
    assert.equal(resolved.services.runtime.image, productionImage);
    assert.equal(resolved.services.runtime.platform, 'linux/amd64');
    assert.equal(
        resolved.services.runtime.build.dockerfile,
        'deploy/runtime/Dockerfile',
    );
    assert.equal(
        resolved.services.runtime.environment.DSH_OPENSHELL_RUNTIME_IMAGE,
        productionImage,
    );
    assert.equal(
        resolved.services.runtime.environment.DSH_OPENSHELL_SSH_PASSWORD,
        undefined,
    );
    await command(
        [
            ...compose,
            'build',
            ...(nodeImage ? ['--build-arg', 'NODE_IMAGE=' + nodeImage] : []),
            'runtime',
        ],
        { cwd: root, env, timeout: 240000 },
    );
    await mkdir(join(root, 'probes/bin'), { recursive: true });
    await mkdir(join(root, 'probes/lib'), { recursive: true });
    await writeFile(
        join(root, 'probes/abi.c'),
        String.raw`#define _GNU_SOURCE
#include <unistd.h>
#include <sys/syscall.h>
#include <stdio.h>
#include <errno.h>
int main(void){ long abi=syscall(SYS_landlock_create_ruleset,0,0,1);printf("{\"version\":%ld,\"errno\":%d}\n",abi,abi<0?errno:0);return 0;}
`,
    );
    await command([
        'cc',
        join(root, 'probes/abi.c'),
        '-o',
        join(root, 'probes/abi'),
    ]);
    for (const binary of [
        join(root, 'probes/abi'),
        '/usr/bin/bwrap',
        '/usr/bin/unshare',
    ]) {
        for (const line of (await command(['ldd', binary])).stdout.split(
            '\n',
        )) {
            const path = line.match(/(\/[^ ]+)/)?.[1];
            if (path)
                await copyFile(path, join(root, 'probes/lib', basename(path)));
        }
        await copyFile(binary, join(root, 'probes/bin', basename(binary)));
    }
    await command(
        [
            'docker',
            'build',
            '--network',
            'none',
            '--build-arg',
            'RUNTIME_IMAGE=' + productionImage,
            '-t',
            image,
            '.',
        ],
        {
            cwd: root,
            timeout: 120000,
        },
    );
    return { helperPath: '/opt/dsh-runtime/confine.mjs', productionImage };
}
