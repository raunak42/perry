import type { InteractiveUi } from "../ui/types";

type BusyUi = Pick<InteractiveUi, "setBusy" | "clearBusy">;

export interface BusyIndicatorController {
    setMessage(message: string): void;
}

export interface BusyIndicatorOptions {
    delayMs?: number;
}

const DEFAULT_BUSY_DELAY_MS = 150;

/**
 * Shows Perry's loader for operations that last long enough to be visible.
 *
 * Fast operations complete without flashing a 0s loader/worked line. Slow
 * operations get a spinner, and callers can update the message as the phase
 * changes (for example, "Checking context" -> "Compacting context").
 */
export async function withBusyIndicator<T>(
    ui: BusyUi,
    message: string,
    operation: (indicator: BusyIndicatorController) => Promise<T> | T,
    options: BusyIndicatorOptions = {},
): Promise<T> {
    const delayMs = Math.max(0, options.delayMs ?? DEFAULT_BUSY_DELAY_MS);
    let currentMessage = message;
    let active = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const start = () => {
        timer = null;
        if (finished) return;
        active = true;
        ui.setBusy(currentMessage);
    };

    if (delayMs === 0) {
        start();
    } else {
        timer = setTimeout(start, delayMs);
        (timer as unknown as { unref?: () => void }).unref?.();
    }

    const indicator: BusyIndicatorController = {
        setMessage(nextMessage: string): void {
            currentMessage = nextMessage;
            if (active) ui.setBusy(currentMessage);
        },
    };

    try {
        return await operation(indicator);
    } finally {
        finished = true;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (active) {
            ui.clearBusy({ showWorkedLine: false });
        }
    }
}
