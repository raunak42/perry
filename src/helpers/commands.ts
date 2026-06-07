export type SlashCommandDefinition = {
    name: string;
    description: string;
};

export const SLASH_COMMANDS: SlashCommandDefinition[] = [
    {
        name: "/help",
        description: "Show available commands",
    },
    {
        name: "/login",
        description: "Log in with OpenAI API key or ChatGPT/Codex",
    },
    {
        name: "/logout",
        description: "Clear the current login",
    },
    {
        name: "/model",
        description: "Choose model and reasoning level",
    },
    {
        name: "/thinking",
        description: "Choose or set thinking/reasoning level",
    },
    {
        name: "/settings",
        description: "Configure permissions, context handling, subagents, skills, and preferences",
    },
    {
        name: "/permissions",
        description: "Configure tool permission mode",
    },
    {
        name: "/mcp",
        description: "Show, diagnose, or reload MCP servers and tools",
    },
    {
        name: "/skills",
        description: "List or reload reusable workflow skills",
    },
    {
        name: "/skill",
        description: "Apply a reusable workflow skill to the next request",
    },
    {
        name: "/plan",
        description: "Toggle interactive planning mode",
    },
    {
        name: "/subagents",
        description: "Toggle whether Perry may spawn subagents",
    },
    {
        name: "/accept",
        description: "Approve the current plan and execute it",
    },
    {
        name: "/session",
        description: "Show current local session details",
    },
    {
        name: "/resume",
        description: "Resume a saved local session",
    },
    {
        name: "/continue",
        description: "Continue the most recent local session",
    },
    {
        name: "/new",
        description: "Start a new local session",
    },
    {
        name: "/compact",
        description: "Manually compact the session context",
    },
    {
        name: "/quit",
        description: "Exit Perry",
    },
];

export function getSlashCommandName(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return null;

    const [commandName] = trimmed.split(/\s+/, 1);
    if (!commandName) return null;

    return SLASH_COMMANDS.some((command) => command.name === commandName) ? commandName : null;
}

export function isSlashCommandInput(input: string): boolean {
    return getSlashCommandName(input) !== null;
}

export function filterSlashCommands(input: string): SlashCommandDefinition[] {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) {
        return [];
    }

    const [firstToken] = trimmed.split(/\s+/, 1);
    if (firstToken && firstToken.includes("/", 1)) {
        return [];
    }

    const query = (firstToken ?? trimmed).slice(1).toLowerCase();
    if (!query) {
        return SLASH_COMMANDS;
    }

    return SLASH_COMMANDS.filter((command) => command.name.slice(1).toLowerCase().startsWith(query));
}
