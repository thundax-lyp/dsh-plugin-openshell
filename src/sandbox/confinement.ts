/** Strict consumers must check the provider result before dispatching its argv. */
export function requireFullConfinement<
    T extends {
        argv: readonly string[];
        enforcement: 'full' | 'partial';
    },
>(wrapped: T): T {
    if (wrapped.enforcement !== 'full' || wrapped.argv.length === 0)
        throw new Error('full confinement required');
    return wrapped;
}
