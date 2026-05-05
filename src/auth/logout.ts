import fs from "node:fs/promises";
import { authPath } from "../constants";

export async function logout(): Promise<void> {
    try {
        await fs.unlink(authPath);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
        }
    }
}