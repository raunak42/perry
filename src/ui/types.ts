export interface PromptOptions {
    placeholder?: string;
    enableSlashCommands?: boolean;
    history?: string[] | (() => string[]);
    onCycleReasoningLevel?: () => string | void;
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

export interface StartupCard {
    title: string;
    subtitle?: string;
    imagePath?: string | null;
    ansiImagePath?: string | null;
    ansiImageMaxWidth?: number;
    ansiImageMaxHeight?: number;
    lines: SessionDetailLine[];
}

export type PersistableToolTrace = {
    id: string;
    displayId?: number;
    toolName: string;
    args?: unknown;
    argsText?: string;
    output: string;
    status: "pending" | "running" | "complete" | "error" | "aborted";
    details?: unknown;
    expanded?: boolean;
    startedAt?: number;
    finishedAt?: number;
};

export interface InteractiveUi {
    onEscape?(listener: () => void): () => void;
    ask(prompt: string, options?: PromptOptions): Promise<string>;
    choose<T = string>(prompt: string, options: ChoiceOption<T>[], initialValue?: T): Promise<T>;
    write(message: string): void;
    writeWarning(message: string): void;
    writeError(message: string): void;
    writeUser(message: string): void;
    writeAssistant(message: string): void;
    writeThinking(message: string): void;
    writeStartupCard(card: StartupCard): void;
    startStreamingBlock(label?: string, variant?: "default" | "thinking"): string;
    appendToStreamingBlock(id: string, text: string): void;
    finishStreamingBlock(id: string, options?: { retain?: boolean }): void;
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
    restoreToolTrace?(trace: PersistableToolTrace): void;
    onToolTraceFinished?(listener: (trace: PersistableToolTrace) => void): () => void;
    createSilentClone?(): InteractiveUi;
    expandTrace(reference: string): boolean;
    refreshHistory(): void;
    setStatus(message: string): void;
    setReasoningLevel(level: string): void;
    setSessionDetails(lines: SessionDetailLine[]): void;
    setBusy(message?: string): void;
    clearBusy(options?: { showWorkedLine?: boolean }): void;
    cancelActiveInput(): void;
    triggerEscape(): void;
    destroy(): void;
}
