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
        description: "Choose model, reasoning level, and context handling",
    },
    {
        name: "/trace",
        description: "Expand a capped trace by its visible trace number",
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
        name: "/quit",
        description: "Exit Perry",
    },
];

export function filterSlashCommands(input: string): SlashCommandDefinition[] {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) {
        return [];
    }

    const query = trimmed.slice(1).toLowerCase();
    if (!query) {
        return SLASH_COMMANDS;
    }

    return SLASH_COMMANDS.filter((command) => command.name.slice(1).toLowerCase().startsWith(query));
}
