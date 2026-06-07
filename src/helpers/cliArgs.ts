export function normalizeCliArgv(argv: string[]): string[] {
    const normalized: string[] = [];
    let pastOptionSeparator = false;

    for (const arg of argv) {
        if (pastOptionSeparator) {
            normalized.push(arg);
            continue;
        }

        if (arg === "--") {
            pastOptionSeparator = true;
            normalized.push(arg);
            continue;
        }

        normalized.push(arg === "-nc" ? "--no-context-files" : arg);
    }

    return normalized;
}
