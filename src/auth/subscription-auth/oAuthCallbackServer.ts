import express from "express";
import type { Server } from "node:http";
import { oauthCallbackPort } from "../../constants";

export function waitForOAuthCallback(expectedState: string): Promise<{ code: string }> {
    return new Promise((resolve, reject) => {
        const app = express();
        let server: Server;

        app.get("/auth/callback", (req, res) => {
            const code = typeof req.query.code === "string" ? req.query.code : null;
            const error = typeof req.query.error === "string" ? req.query.error : null;
            const state = typeof req.query.state === "string" ? req.query.state : null;

            if (error) {
                res.status(400).send("Login failed. You can close this tab.");
                server.close();
                reject(new Error(error));
                return;
            }

            if (!code) {
                res.status(400).send("Missing OAuth code. You can close this tab.");
                server.close();
                reject(new Error("Missing OAuth code"));
                return;
            }

            if (state !== expectedState) {
                res.status(400).send("Invalid state. You can close this tab.");
                server.close();
                reject(new Error("Invalid OAuth state"));
                return;
            }

            res.status(200).send(`
        <html>
          <body style="font-family: sans-serif; padding: 40px;">
            <h1>Perry login successful</h1>
            <p>You can close this tab and return to your terminal.</p>
          </body>
        </html>
      `);

            server.close();
            resolve({ code });
        });

        app.use((_req, res) => {
            res.status(404).send("Not found");
        });

        server = app.listen(oauthCallbackPort, "127.0.0.1");
    });
}
