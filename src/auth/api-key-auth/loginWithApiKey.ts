import fs from "node:fs/promises";
import { authDir, authPath } from "../../constants";
import { AuthFile } from "../../helpers/getAuthFile";
import type { InteractiveUi } from "../../ui/types";

export async function loginWithApiKey(
  ui: InteractiveUi
): Promise<void> {
  const apiKey = await ui.ask("Paste your OpenAI API key:", {
    placeholder: "sk-...",
  });
  const trimmed = apiKey.trim();

  if (!trimmed.startsWith("sk-")) {
    throw new Error("That does not look like an OpenAI API key.");
  }

  await fs.mkdir(authDir, { recursive: true });

  let existing: AuthFile = {};

  try {
    const raw = await fs.readFile(authPath, "utf-8");
    existing = JSON.parse(raw) as AuthFile;
  } catch {
    existing = {};
  }

  existing.activeProvider = "openai-api-key";
  existing.openaiApiKey = {
    apiKey: trimmed,
  };

  await fs.writeFile(authPath, JSON.stringify(existing, null, 2), {
    mode: 0o600,
  });
}