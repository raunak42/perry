import open from "open";
import fs from "node:fs/promises";
import { authDir, authPath } from "../../constants";
import { OpenAICodexTokens } from "../types";
import { AuthFile } from "../../helpers/getAuthFile";
import { CLIENT_ID, createOpenaiLoginUrl } from "./openaiLoginUrl";
import { waitForOAuthCallback } from "./oAuthCallbackServer";

export async function loginWithSubscription() {
    const login = createOpenaiLoginUrl();
    console.log("Opening OpenAI login in browser...");
    console.log(login.url);

    const callbackPromise = waitForOAuthCallback(login.state);

    await open(login.url);

    const { code } = await callbackPromise;

    const res = await fetch("https://auth.openai.com/oauth/token", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            code,
            redirect_uri: "http://localhost:1455/auth/callback",
            code_verifier: login.verifier,
        }),
    })

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Token exchange failed: ${res.status}\n${errorText}`);
    }

    const tokens = await res.json() as OpenAICodexTokens
    const tokensWithExpiry: OpenAICodexTokens = {
        ...tokens,
        expires_at: tokens.expires_in
            ? Date.now() + tokens.expires_in * 1000 - 60_000 //refreshing one minute eraly
            : undefined,
    }

    //store tokens locally

    await fs.mkdir(authDir, { recursive: true })
    let existing: AuthFile = {};

    try {
        existing = JSON.parse(await fs.readFile(authPath, "utf-8"));
    } catch {
        existing = {};
    }

    existing.activeProvider = "openai-codex";
    existing.openaiCodex = tokensWithExpiry;

    await fs.writeFile(authPath, JSON.stringify(existing, null, 2), {
        mode: 0o600,
    });
}