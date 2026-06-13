import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PACKAGE_NAME = "@perry-ai/cli";
export const DEFAULT_PACKAGE_VERSION = "0.0.0";
export const DEFAULT_INSTALLED_PERRY_HOME_DIRNAME = ".perry-ai";
export const DEFAULT_DEV_PERRY_HOME_DIRNAME = ".perry-dev";

export type PackageMetadata = {
    name: string;
    version: string;
    root: string;
};

function parsePackageMetadata(filePath: string): PackageMetadata | null {
    try {
        const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
            name?: unknown;
            version?: unknown;
        };
        return {
            name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : DEFAULT_PACKAGE_NAME,
            version: typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : DEFAULT_PACKAGE_VERSION,
            root: path.dirname(filePath),
        };
    } catch {
        return null;
    }
}

export function findPackageRoot(startDir = __dirname): string {
    let current = path.resolve(startDir);
    const root = path.parse(current).root;

    while (true) {
        const packageJsonPath = path.join(current, "package.json");
        if (existsSync(packageJsonPath)) return current;

        if (current === root) break;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }

    return process.cwd();
}

export function readPackageMetadata(startDir = __dirname): PackageMetadata {
    const root = findPackageRoot(startDir);
    const metadata = parsePackageMetadata(path.join(root, "package.json"));
    return metadata ?? {
        name: DEFAULT_PACKAGE_NAME,
        version: DEFAULT_PACKAGE_VERSION,
        root,
    };
}

export function getPackageRoot(): string {
    return readPackageMetadata().root;
}

export function getPackageName(): string {
    return readPackageMetadata().name;
}

export function getPackageVersion(): string {
    return readPackageMetadata().version;
}

function expandHomePrefix(value: string): string {
    if (value === "~") return os.homedir();
    if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) {
        return path.join(os.homedir(), value.slice(2));
    }
    return value;
}

export function isRunningFromSourcePackage(startDir = __dirname): boolean {
    const root = findPackageRoot(startDir);
    return existsSync(path.join(root, "src", "index.ts"));
}

export function getDefaultPerryHomeDir(startDir = __dirname): string {
    const dirname = isRunningFromSourcePackage(startDir)
        ? DEFAULT_DEV_PERRY_HOME_DIRNAME
        : DEFAULT_INSTALLED_PERRY_HOME_DIRNAME;
    return path.join(os.homedir(), dirname);
}

export function getPerryHomeDir(env: NodeJS.ProcessEnv = process.env, startDir = __dirname): string {
    const configured = env.PERRY_HOME?.trim();
    return path.resolve(expandHomePrefix(configured || getDefaultPerryHomeDir(startDir)));
}

export function getPerryHomePath(...segments: string[]): string {
    return path.join(getPerryHomeDir(), ...segments);
}
