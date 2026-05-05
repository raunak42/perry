import OpenAI from "openai";
import { logout } from "../auth/logout";
import { loginWithApiKey } from "../auth/api-key-auth/loginWithApiKey";
import readline from "node:readline/promises";
import { loginWithSubscription } from "../auth/subscription-auth/loginWithSubscription";
import { getAuthFile } from "./getAuthFile";
import { State } from "..";


interface HandleSlashProps {
    command: string,
    state: State
    rl: readline.Interface
}


export const handleSlashCommands = async ({
    command,
    state,
    rl
}: HandleSlashProps): Promise<boolean> => {
    switch (command) {
        case "/quit":
            return false

        case "/logout":
            await logout();
            state.client = null;
            state.activeProvider = null;
            console.log("Logged out.");
            return true;

        case "/login":
            console.log("Choose login method:");
            console.log("1. OpenAI API key");
            console.log("2. ChatGPT/Codex subscription");

            const choice = await rl.question("Login method: ");

            if (choice.trim() === "1") {
                await loginWithApiKey(rl);
                const updatedAuth = await getAuthFile();

                if (
                    updatedAuth?.activeProvider === "openai-api-key" &&
                    updatedAuth.openaiApiKey
                ) {
                    state.client = new OpenAI({
                        apiKey: updatedAuth.openaiApiKey.apiKey,
                    });

                    state.activeProvider = "openai-api-key";
                    console.log("Logged in with OpenAI API key.");
                } else {
                    console.log("API key login did not save correctly.");
                }

                return true;
            } else if (choice.trim() === "2") {
                await loginWithSubscription();
                state.client = null;
                state.activeProvider = "openai-codex";
                console.log("Logged in with ChatGPT/Codex subscription.");

                return true;
            } else {
                console.log("Invalid choice.");
                return true;
            }



        default: {
            console.log(`Unknown command: ${command}`);
            console.log("Type /help to see available commands.");
            return true;
        }
    }
}