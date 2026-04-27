import OpenAI from "openai";

export interface Tool {
    name: string;
    definition: OpenAI.Responses.Tool;
    execute: (args: unknown) => Promise<string>
}