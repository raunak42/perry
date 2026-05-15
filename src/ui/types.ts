export interface PromptOptions {
    placeholder?: string;
    enableSlashCommands?: boolean;
}

export interface ChoiceOption<T = string> {
    label: string;
    value: T;
    description?: string;
}

export interface SessionDetailLine {
    left: string;
    right?: string;
}

export interface InteractiveUi {
    ask(prompt: string, options?: PromptOptions): Promise<string>;
    choose<T = string>(prompt: string, options: ChoiceOption<T>[], initialValue?: T): Promise<T>;
    write(message: string): void;
    writeWarning(message: string): void;
    writeUser(message: string): void;
    writeThinking(message: string): void;
    startStreamingBlock(label?: string, variant?: "default" | "thinking"): string;
    appendToStreamingBlock(id: string, text: string): void;
    finishStreamingBlock(id: string): void;
    showToolCall(
        id: string,
        toolName: string,
        args?: unknown,
        status?: "pending" | "running" | "complete" | "error" | "aborted",
        output?: string,
        details?: unknown,
    ): void;
    showToolCallArguments(id: string, toolName: string, argsText: string, args?: unknown): void;
    updateToolCallArguments(id: string, argsText: string, args?: unknown): void;
    startToolExecution(id: string): void;
    updateToolExecution(id: string, output: string, isError?: boolean, details?: unknown): void;
    finishToolExecution(id: string, output: string, isError?: boolean, details?: unknown): void;
    expandTrace(reference: string): boolean;
    refreshHistory(): void;
    setStatus(message: string): void;
    setReasoningLevel(level: string): void;
    setSessionDetails(lines: SessionDetailLine[]): void;
    setBusy(message?: string): void;
    clearBusy(): void;
    cancelActiveInput(): void;
    destroy(): void;
}
