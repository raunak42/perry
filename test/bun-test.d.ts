declare module "bun:test" {
    export function test(name: string, fn: () => unknown | Promise<unknown>): void;
}
