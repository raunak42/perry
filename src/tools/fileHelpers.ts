import path from "node:path";

export function resolveToolPath(inputPath: string): string {
    return path.isAbsolute(inputPath)
        ? path.resolve(inputPath)
        : path.resolve(process.cwd(), inputPath);
}

export function detectLanguageFromPath(filePath: string): string | null {
    const normalized = filePath.toLowerCase();

    if (normalized.endsWith(".json") || normalized.endsWith(".jsonc")) {
        return "json";
    }

    if (
        normalized.endsWith(".sh") ||
        normalized.endsWith(".bash") ||
        normalized.endsWith(".zsh") ||
        normalized.endsWith(".env")
    ) {
        return "bash";
    }

    if (
        normalized.endsWith(".ts") ||
        normalized.endsWith(".tsx") ||
        normalized.endsWith(".js") ||
        normalized.endsWith(".jsx") ||
        normalized.endsWith(".mjs") ||
        normalized.endsWith(".cjs") ||
        normalized.endsWith(".py") ||
        normalized.endsWith(".rb") ||
        normalized.endsWith(".go") ||
        normalized.endsWith(".rs") ||
        normalized.endsWith(".java") ||
        normalized.endsWith(".c") ||
        normalized.endsWith(".cc") ||
        normalized.endsWith(".cpp") ||
        normalized.endsWith(".h") ||
        normalized.endsWith(".hpp") ||
        normalized.endsWith(".css") ||
        normalized.endsWith(".scss") ||
        normalized.endsWith(".html") ||
        normalized.endsWith(".md") ||
        normalized.endsWith(".yaml") ||
        normalized.endsWith(".yml") ||
        normalized.endsWith(".toml") ||
        normalized.endsWith(".xml")
    ) {
        return "generic";
    }

    return null;
}

export function normalizeToLf(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
