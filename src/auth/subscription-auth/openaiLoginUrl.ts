import crypto from "node:crypto";
import { oauthCallbackUrl } from "../../constants";

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";

const SCOPES = [
    "openid",
    "profile",
    "email",
    "offline_access",
    // "api.responses.write"
];

export function createOpenaiLoginUrl() {
    const url = new URL(AUTHORIZE_URL);

    const { challenge, verifier } = generatePKCE()
    const state = crypto.randomUUID()

    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("state", state);
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", oauthCallbackUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("id_token_add_organizations", "true");
    url.searchParams.set("codex_cli_simplified_flow", "true");
    url.searchParams.set("originator", "codex_cli");

    return {
        url: url.toString(),
        state,
        verifier
    };

}

export function generatePKCE() {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto
        .createHash("sha256")
        .update(verifier)
        .digest("base64url");

    return { challenge, verifier }
}

createOpenaiLoginUrl()
