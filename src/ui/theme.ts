export type ThemeMode = "dark" | "light";

export interface UiTheme {
    mode: ThemeMode;
    appBackground: string;
    chromeBackground: string;
    panelBackground: string;
    panelBackgroundMuted: string;
    panelBackgroundStrong: string;
    cardBackground: string;
    cardBackgroundAlt: string;
    inputBackground: string;
    overlayBackground: string;
    border: string;
    borderStrong: string;
    borderSoft: string;
    text: string;
    textMuted: string;
    textSubtle: string;
    accent: string;
    accentSoft: string;
    assistant: string;
    user: string;
    thinking: string;
    success: string;
    warning: string;
    danger: string;
    info: string;
    codeBackground: string;
}

export function createUiTheme(mode: ThemeMode = "dark"): UiTheme {
    if (mode === "light") {
        return {
            mode,
            appBackground: "#edf2ff",
            chromeBackground: "#ffffff",
            panelBackground: "#ffffff",
            panelBackgroundMuted: "#f6f8ff",
            panelBackgroundStrong: "#eef2ff",
            cardBackground: "#ffffff",
            cardBackgroundAlt: "#f8faff",
            inputBackground: "#f8faff",
            overlayBackground: "#dbe4ff",
            border: "#c7d2fe",
            borderStrong: "#94a3ff",
            borderSoft: "#d8def8",
            text: "#172554",
            textMuted: "#475569",
            textSubtle: "#64748b",
            accent: "#5b21b6",
            accentSoft: "#0f766e",
            assistant: "#1d4ed8",
            user: "#b45309",
            thinking: "#7c3aed",
            success: "#15803d",
            warning: "#b45309",
            danger: "#be123c",
            info: "#0f766e",
            codeBackground: "#eef2ff",
        };
    }

    return {
        mode,
        appBackground: "#07111f",
        chromeBackground: "#0b1627",
        panelBackground: "#0d172a",
        panelBackgroundMuted: "#101d32",
        panelBackgroundStrong: "#13223c",
        cardBackground: "#101b30",
        cardBackgroundAlt: "#0f1a2d",
        inputBackground: "#0a1323",
        overlayBackground: "#020817",
        border: "#223250",
        borderStrong: "#35507a",
        borderSoft: "#18253b",
        text: "#e2e8f0",
        textMuted: "#9fb0ca",
        textSubtle: "#7083a1",
        accent: "#8b5cf6",
        accentSoft: "#22d3ee",
        assistant: "#38bdf8",
        user: "#f59e0b",
        thinking: "#c084fc",
        success: "#34d399",
        warning: "#fbbf24",
        danger: "#fb7185",
        info: "#22d3ee",
        codeBackground: "#0a1220",
    };
}
