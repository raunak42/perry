import OpenAI from "openai";
import type { ResponseInputFile, ResponseInputImage, ResponseInputText } from "openai/resources/responses/responses";

export type ToolModelOutput = string | Array<ResponseInputText | ResponseInputImage | ResponseInputFile>;

export interface ToolExecutionResult<TDetails = unknown> {
    output: string;
    modelOutput?: ToolModelOutput;
    isError?: boolean;
    details?: TDetails;
}

export interface ToolExecutionOptions<TDetails = unknown> {
    onUpdate?: (result: ToolExecutionResult<TDetails>) => void;
    signal?: AbortSignal;
}

export interface Tool<TArgs = unknown, TDetails = unknown> {
    name: string;
    definition: OpenAI.Responses.Tool;
    execute: (args: TArgs, options?: ToolExecutionOptions<TDetails>) => Promise<ToolExecutionResult<TDetails>>;
}
