import { isSlashCommandInput } from "./commands";
import { TerminalUi } from "../ui/terminal-ui";

export type PersistentPromptController = ReturnType<typeof createPersistentPromptController>;

export function createPersistentPromptController(
    ui: TerminalUi,
    onUserInterrupt: () => void,
    options: {
        getHistory?: () => string[];
        onCycleReasoningLevel?: () => string | void;
    } = {},
) {
    const pending: string[] = [];
    const waiters: Array<{ resolve: (value: string) => void; reject: (error: Error) => void }> = [];
    let stopped = false;
    let paused = false;
    let pauseResolver: (() => void) | null = null;
    let pauseReadyResolver: (() => void) | null = null;
    let pauseReadyPromise: Promise<void> | null = null;
    let running = false;
    let asking = false;

    const markPauseReady = () => {
        const resolve = pauseReadyResolver;
        pauseReadyResolver = null;
        resolve?.();
    };

    const updateQueuedDisplay = () => {
        ui.setQueuedSteeringMessages(pending.filter((message) => !isSlashCommandInput(message)));
    };

    ui.setQueuedMessageEditHandler(() => {
        const editable = pending.filter((message) => !isSlashCommandInput(message));
        if (editable.length === 0) return "";
        const deferredCommands = pending.filter((message) => isSlashCommandInput(message));
        pending.splice(0, pending.length, ...deferredCommands);
        updateQueuedDisplay();
        return editable.join("\n\n");
    });

    const failWaiters = (error: Error) => {
        for (const waiter of waiters.splice(0)) waiter.reject(error);
    };

    const enqueue = (value: string) => {
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(value);
        else {
            pending.push(value);
            updateQueuedDisplay();
        }
    };

    const waitWhilePaused = async () => {
        while (paused && !stopped) {
            markPauseReady();
            await new Promise<void>((resolve) => {
                pauseResolver = resolve;
            });
        }
    };

    const run = async () => {
        if (running) return;
        running = true;
        try {
            while (!stopped) {
                await waitWhilePaused();
                if (stopped) break;
                if (paused) continue;
                try {
                    asking = true;
                    const answer = await ui.ask(">", {
                        placeholder: "Type a message or a slash command",
                        enableSlashCommands: true,
                        history: () => {
                            const submitted = options.getHistory?.() ?? [];
                            const queued = pending.filter((message) => !isSlashCommandInput(message));
                            return [...submitted, ...queued];
                        },
                        onCycleReasoningLevel: options.onCycleReasoningLevel,
                    });
                    asking = false;
                    if (!stopped && answer.trim().length > 0) enqueue(answer);
                } catch (error) {
                    asking = false;
                    if ((error as Error).name === "AbortError" && paused) {
                        markPauseReady();
                        await waitWhilePaused();
                        continue;
                    }
                    if (stopped) break;
                    if ((error as Error).name === "UserInterruptError") {
                        stopped = true;
                        failWaiters(error as Error);
                        onUserInterrupt();
                        break;
                    }
                    if ((error as Error).name !== "AbortError") throw error;
                }
            }
        } finally {
            running = false;
        }
    };

    return {
        start(): void {
            void run();
        },
        async pause(): Promise<void> {
            if (paused && pauseReadyPromise) {
                await pauseReadyPromise;
                return;
            }
            paused = true;
            pauseReadyPromise = new Promise<void>((resolve) => {
                pauseReadyResolver = resolve;
            });
            ui.cancelActiveInput();
            if (!asking) markPauseReady();
            await pauseReadyPromise;
        },
        resume(): void {
            if (!paused) return;
            paused = false;
            pauseReadyPromise = null;
            pauseReadyResolver = null;
            const resolve = pauseResolver;
            pauseResolver = null;
            resolve?.();
            void run();
        },
        stop(): void {
            stopped = true;
            paused = false;
            pauseReadyResolver?.();
            pauseReadyResolver = null;
            pauseReadyPromise = null;
            const resolve = pauseResolver;
            pauseResolver = null;
            resolve?.();
            ui.cancelActiveInput();
            ui.setQueuedMessageEditHandler(null);
            ui.setQueuedSteeringMessages([]);
        },
        take(): Promise<string> {
            const value = pending.shift();
            updateQueuedDisplay();
            if (value !== undefined) return Promise.resolve(value);
            return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
        },
        drain(): string[] {
            const drained = pending.splice(0);
            updateQueuedDisplay();
            return drained;
        },
        pushFront(values: string[]): void {
            pending.unshift(...values);
            updateQueuedDisplay();
        },
    };
}
