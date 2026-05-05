export type AuthProvider = "openai-api-key" | "openai-codex";

export type OpenAICodexTokens = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
  scope?: string;
};