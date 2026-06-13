import type { InteractiveUi } from "../ui/types";

export function createStreamingTextBlockManager(ui: InteractiveUi, variant: "default" | "thinking") {
    const blockIds = new Map<string, string>();
    let streamed = false;

    return {
        get hasStreamedText(): boolean {
            return streamed;
        },
        onStart(itemId: string): void {
            if (blockIds.has(itemId)) {
                return;
            }

            const blockId = ui.startStreamingBlock("", variant);
            blockIds.set(itemId, blockId);
        },
        onDelta(itemId: string, delta: string): void {
            let blockId = blockIds.get(itemId);
            if (!blockId) {
                this.onStart(itemId);
                blockId = blockIds.get(itemId);
            }

            if (!blockId || delta.length === 0) {
                return;
            }

            streamed = true;
            ui.appendToStreamingBlock(blockId, delta);
        },
        onDone(itemId: string): void {
            const blockId = blockIds.get(itemId);
            if (!blockId) {
                return;
            }

            ui.finishStreamingBlock(blockId);
            blockIds.delete(itemId);
        },
        finishAll(): void {
            for (const [itemId, blockId] of blockIds.entries()) {
                ui.finishStreamingBlock(blockId);
                blockIds.delete(itemId);
            }
        },
    };
}

export function createThinkingTraceStreamer(ui: InteractiveUi) {
    const manager = createStreamingTextBlockManager(ui, "thinking");
    return {
        get hasStreamedThinking(): boolean {
            return manager.hasStreamedText;
        },
        onStart(itemId: string): void {
            manager.onStart(itemId);
        },
        onDelta(itemId: string, delta: string): void {
            manager.onDelta(itemId, delta);
        },
        onDone(itemId: string): void {
            manager.onDone(itemId);
        },
        finishAll(): void {
            manager.finishAll();
        },
    };
}

export function createAssistantTextStreamer(ui: InteractiveUi) {
    let blockId: string | null = null;
    let streamed = false;

    return {
        get hasStreamedText(): boolean {
            return streamed;
        },
        onDelta(_itemId: string, delta: string): void {
            if (delta.length === 0) return;
            if (!blockId) blockId = ui.startStreamingBlock("", "default");
            streamed = true;
            ui.appendToStreamingBlock(blockId, delta);
        },
        onDone(_itemId: string): void {
            // Keep one assistant block alive for the whole response. Some
            // providers/proxies can emit multiple text item ids or premature
            // done events; finishing per item creates repeated prefix blocks.
        },
        finishAll(retain = true): void {
            if (!blockId) return;
            ui.finishStreamingBlock(blockId, { retain });
            blockId = null;
        },
    };
}
