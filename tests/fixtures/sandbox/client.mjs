import { Buffer } from 'node:buffer';
/** SDK-shaped fixture for confinement responses; no local command execution. */
export function sandboxClient() {
    const state = { response: {}, calls: [] };
    const client = {
        async execInteractive(name, argv, options) {
            options.signal.throwIfAborted();
            const request = JSON.parse(
                Buffer.from(argv[2], 'base64').toString(),
            );
            state.calls.push({ name, argv, options, request });
            const raw = Buffer.from(
                JSON.stringify({
                    version: '0.2.1-rc.4',
                    argv: request.argv,
                    enforcement: 'full',
                    denialSignatures: ['denied'],
                    runnerFailureRules: [],
                    ...state.response,
                }),
            );
            // Split a multibyte character to exercise buffered helper decoding.
            const cut = raw.indexOf(Buffer.from('字')) + 1;
            return {
                write() {},
                closeInput() {},
                cancel() {},
                done: Promise.resolve(0),
                output: (async function* () {
                    yield { stream: 'stdout', data: raw.subarray(0, cut) };
                    yield { stream: 'stdout', data: raw.subarray(cut) };
                    yield { type: 'exit', exitCode: 0 };
                })(),
            };
        },
    };
    return { client, state };
}
