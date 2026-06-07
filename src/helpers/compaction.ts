import type { ContextLevel } from "./models";
import { getModelDisplayMetadata } from "./models";
import type {
    PersistedChatMessage,
    SessionCompactionEntry,
    SessionEntry,
    SessionMessageEntry,
} from "./sessionManager";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

export interface CompactionSettings {
    reserveTokens: number;
    keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
};

export interface CutPointResult {
    firstKeptEntryIndex: number;
    turnStartIndex: number;
    isSplitTurn: boolean;
}

export interface CompactionPreparation {
    firstKeptEntryId: string;
    messagesToSummarize: PersistedChatMessage[];
    turnPrefixMessages: PersistedChatMessage[];
    isSplitTurn: boolean;
    tokensBefore: number;
    previousSummary?: string;
    settings: CompactionSettings;
}

export interface CompactionResult {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
}

function isConversationMessage(entry: SessionEntry): entry is SessionMessageEntry {
    return entry.type === "message"
        && (entry.message.role === "user" || entry.message.role === "assistant");
}

function getLatestCompactionIndex(entries: SessionEntry[]): number {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index]?.type === "compaction") {
            return index;
        }
    }
    return -1;
}

function getCompactionEntry(entry: SessionEntry | undefined): SessionCompactionEntry | null {
    return entry?.type === "compaction" ? entry : null;
}

export function createCompactionSummaryMessage(summary: string): PersistedChatMessage {
    return {
        role: "user",
        content: `${COMPACTION_SUMMARY_PREFIX}${summary}${COMPACTION_SUMMARY_SUFFIX}`,
    };
}

export function estimateTokens(message: PersistedChatMessage): number {
    return Math.ceil(Buffer.byteLength(message.content, "utf8") / 4);
}

export function estimateContextTokens(messages: PersistedChatMessage[]): number {
    return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

export function buildContextHistoryFromEntries(entries: SessionEntry[]): PersistedChatMessage[] {
    const latestCompactionIndex = getLatestCompactionIndex(entries);
    if (latestCompactionIndex < 0) {
        return entries
            .filter(isConversationMessage)
            .map((entry) => entry.message);
    }

    const compaction = getCompactionEntry(entries[latestCompactionIndex]);
    if (!compaction) {
        return entries
            .filter(isConversationMessage)
            .map((entry) => entry.message);
    }

    const messages: PersistedChatMessage[] = [createCompactionSummaryMessage(compaction.summary)];
    let foundFirstKept = false;

    for (let index = 0; index < latestCompactionIndex; index += 1) {
        const entry = entries[index];
        if (!foundFirstKept && entry.id === compaction.firstKeptEntryId) {
            foundFirstKept = true;
        }
        if (foundFirstKept && isConversationMessage(entry)) {
            messages.push(entry.message);
        }
    }

    for (let index = latestCompactionIndex + 1; index < entries.length; index += 1) {
        const entry = entries[index];
        if (isConversationMessage(entry)) {
            messages.push(entry.message);
        }
    }

    return messages;
}

function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
    for (let index = entryIndex; index >= startIndex; index -= 1) {
        const entry = entries[index];
        if (entry?.type === "message" && entry.message.role === "user") {
            return index;
        }
    }
    return -1;
}

function findCutPoint(
    entries: SessionEntry[],
    startIndex: number,
    endIndex: number,
    keepRecentTokens: number,
): CutPointResult {
    const validCutPoints = entries
        .map((entry, index) => ({ entry, index }))
        .filter(({ index, entry }) => index >= startIndex && index < endIndex && isConversationMessage(entry))
        .map(({ index }) => index);

    if (validCutPoints.length === 0) {
        return {
            firstKeptEntryIndex: startIndex,
            turnStartIndex: -1,
            isSplitTurn: false,
        };
    }

    let accumulatedTokens = 0;
    let cutIndex = validCutPoints[0]!;

    for (let index = endIndex - 1; index >= startIndex; index -= 1) {
        const entry = entries[index];
        if (!isConversationMessage(entry)) {
            continue;
        }

        accumulatedTokens += estimateTokens(entry.message);
        if (accumulatedTokens >= keepRecentTokens) {
            cutIndex = index;
            break;
        }
    }

    const cutEntry = entries[cutIndex];
    const isUserMessage = cutEntry?.type === "message" && cutEntry.message.role === "user";
    const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

    return {
        firstKeptEntryIndex: cutIndex,
        turnStartIndex,
        isSplitTurn: !isUserMessage && turnStartIndex !== -1,
    };
}

function collectMessages(entries: SessionEntry[], startIndex: number, endIndex: number): PersistedChatMessage[] {
    const messages: PersistedChatMessage[] = [];
    for (let index = startIndex; index < endIndex; index += 1) {
        const entry = entries[index];
        if (isConversationMessage(entry)) {
            messages.push(entry.message);
        }
    }
    return messages;
}

export function prepareCompaction(
    entries: SessionEntry[],
    settings: CompactionSettings = DEFAULT_COMPACTION_SETTINGS,
): CompactionPreparation | null {
    if (entries.length === 0) {
        return null;
    }

    if (entries[entries.length - 1]?.type === "compaction") {
        return null;
    }

    const previousCompactionIndex = getLatestCompactionIndex(entries);
    const previousCompaction = previousCompactionIndex >= 0
        ? getCompactionEntry(entries[previousCompactionIndex])
        : null;

    let boundaryStart = 0;
    let previousSummary: string | undefined;

    if (previousCompaction) {
        previousSummary = previousCompaction.summary;
        const firstKeptIndex = entries.findIndex((entry) => entry.id === previousCompaction.firstKeptEntryId);
        boundaryStart = firstKeptIndex >= 0 ? firstKeptIndex : previousCompactionIndex + 1;
    }

    const boundaryEnd = entries.length;
    const tokensBefore = estimateContextTokens(buildContextHistoryFromEntries(entries));
    const cutPoint = findCutPoint(entries, boundaryStart, boundaryEnd, settings.keepRecentTokens);
    const firstKeptEntry = entries[cutPoint.firstKeptEntryIndex];

    if (!firstKeptEntry?.id) {
        return null;
    }

    const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
    const messagesToSummarize = collectMessages(entries, boundaryStart, historyEnd);
    const turnPrefixMessages = cutPoint.isSplitTurn
        ? collectMessages(entries, cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex)
        : [];

    if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
        return null;
    }

    return {
        firstKeptEntryId: firstKeptEntry.id,
        messagesToSummarize,
        turnPrefixMessages,
        isSplitTurn: cutPoint.isSplitTurn,
        tokensBefore,
        previousSummary,
        settings,
    };
}

export function getCompactionThreshold(
    model: string,
    level: ContextLevel,
    provider: "openai-api-key" | "openai-codex" | null,
): number | null {
    const contextWindow = getModelDisplayMetadata(model, provider).contextWindow;
    if (!contextWindow) {
        return null;
    }
    if (level === "balanced") {
        return Math.floor(contextWindow * 0.8);
    }
    if (level === "aggressive") {
        return Math.floor(contextWindow * 0.6);
    }
    return null;
}

export function serializeConversation(messages: PersistedChatMessage[]): string {
    return messages.map((message) => {
        if (message.role === "assistant") {
            return `[Assistant]: ${message.content}`;
        }
        return `[User]: ${message.content}`;
    }).join("\n\n");
}

export function buildHistorySummaryPrompt(
    messages: PersistedChatMessage[],
    previousSummary?: string,
    customInstructions?: string,
): string {
    const conversationText = serializeConversation(messages);
    let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;

    if (previousSummary) {
        promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
    }

    let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
    if (customInstructions) {
        basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
    }

    promptText += basePrompt;
    return promptText;
}

export function buildTurnPrefixSummaryPrompt(messages: PersistedChatMessage[]): string {
    const conversationText = serializeConversation(messages);
    return `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
}

export function buildCompactionSummary(
    preparation: CompactionPreparation,
    historySummary: string,
    turnPrefixSummary?: string,
): CompactionResult {
    const summary = preparation.isSplitTurn && turnPrefixSummary
        ? `${historySummary}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixSummary}`
        : historySummary;

    return {
        summary,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
    };
}
