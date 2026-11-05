import { Buffer } from 'node:buffer';
/** Protocol fixture only; filesystem behavior is verified against the real image. */
export function fileClient() {
    const state = {
        calls: [],
        value: undefined,
        error: undefined,
        version: '0.2.1-rc.4',
        cancelled: 0,
    };
    const client = {
        async execInteractive(name, argv, options) {
            options.signal.throwIfAborted();
            let close;
            const closed = new Promise((resolve) => {
                close = resolve;
            });
            const chunks = [];
            const call = { name, argv, options, request: undefined, sizes: [] };
            state.calls.push(call);
            const session = {
                write(data) {
                    chunks.push(data);
                    call.sizes.push(data.length);
                },
                closeInput() {
                    call.request = JSON.parse(Buffer.concat(chunks).toString());
                    close();
                },
                cancel() {
                    state.cancelled++;
                },
                done: closed.then(() => 0),
                output: (async function* () {
                    await closed;
                    const data = Buffer.from(
                        JSON.stringify({
                            version: state.version,
                            value: state.value,
                            ...(state.error ? { error: state.error } : {}),
                        }),
                    );
                    // Split every byte so multibyte UTF-8 crosses SDK frame boundaries.
                    for (const byte of data)
                        yield { stream: 'stdout', data: Buffer.from([byte]) };
                })(),
            };
            return session;
        },
    };
    return { client, state };
}
