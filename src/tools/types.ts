import OpenAI from "openai";

export interface Tool<TArgs = unknown> {
    name: string;
    definition: OpenAI.Responses.Tool;
    execute: (args: TArgs) => Promise<string>
}