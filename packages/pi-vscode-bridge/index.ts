/**
 * pi-vscode-bridge — attach a VS Code window and receive file references in the input editor.
 */

import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import {
    BridgeClient,
    BridgeIoError,
    BridgeRejectedError,
    createBridgeClient,
    runBridge,
    type BridgeClientInstance,
    type BridgeClientShape,
} from "./src/runtime.ts";

const EXTENSION_ID = "vscode-bridge";

export default function (pi: ExtensionAPI) {
    let bridgeRuntime: BridgeClientInstance | undefined;
    let bridgeService: BridgeClientShape | undefined;
    let sessionContext: ExtensionContext | undefined;
    let closing: Promise<void> | undefined;

    const service = (): BridgeClientShape => {
        if (!bridgeService)
            throw new Error("VS Code bridge runtime is not initialized.");
        return bridgeService;
    };

    const run = <A, E>(effect: import("effect").Effect.Effect<A, E>) => {
        if (!bridgeRuntime)
            throw new Error("VS Code bridge runtime is not initialized.");
        return runBridge(bridgeRuntime, effect);
    };

    const clearStatus = () => {
        if (sessionContext?.hasUI) {
            sessionContext.ui.setStatus(EXTENSION_ID, undefined);
        }
    };

    const setAttachedStatus = () => {
        if (sessionContext?.hasUI) {
            sessionContext.ui.setStatus(EXTENSION_ID, "vscode ✓");
        }
    };

    const makeCallbacks = () => ({
        onPrefill: (text: string) => {
            if (sessionContext?.hasUI) {
                sessionContext.ui.pasteToEditor(text);
            }
        },
        onDetached: (reason: "superseded" | "server-shutdown") => {
            clearStatus();
            if (!sessionContext?.hasUI) return;
            sessionContext.ui.notify(
                reason === "superseded"
                    ? "Another Pi agent took over the VS Code bridge."
                    : "VS Code closed the bridge.",
                "info",
            );
        },
        onLost: () => {
            clearStatus();
            if (sessionContext?.hasUI) {
                sessionContext.ui.notify("Lost the VS Code bridge.", "warning");
            }
        },
        onReattached: () => {
            setAttachedStatus();
            if (sessionContext?.hasUI) {
                sessionContext.ui.notify("Reattached to VS Code.", "info");
            }
        },
    });

    pi.on("session_start", async (_event, ctx) => {
        bridgeRuntime = createBridgeClient();
        bridgeService = bridgeRuntime.runSync(BridgeClient);
        sessionContext = ctx;
    });

    pi.on("session_shutdown", async () => {
        if (!bridgeRuntime || !bridgeService) return;
        if (closing) {
            await closing.catch(() => {});
            return;
        }
        closing = (async () => {
            try {
                await run(bridgeService!.disconnect("shutdown"));
            } finally {
                await bridgeRuntime!.dispose();
                bridgeRuntime = undefined;
                bridgeService = undefined;
                sessionContext = undefined;
                closing = undefined;
            }
        })();
        await closing;
    });

    pi.registerCommand("vscode-connect", {
        description:
            "Attach to a VS Code window running the Pi Bridge extension",
        handler: async (_args, ctx) => {
            sessionContext = ctx;
            const servers = await run(service().discover(ctx.cwd));
            if (servers.length === 0) {
                ctx.ui.notify(
                    "No VS Code window with this workspace is running the Pi Bridge extension.",
                    "warning",
                );
                return;
            }

            let server = servers[0]!;
            if (servers.length > 1) {
                const labels = servers.map(
                    (entry) =>
                        `${basename(entry.workspaceFolders[0] ?? entry.socketPath)} (pid ${entry.pid})`,
                );
                const picked = await ctx.ui.select(
                    "Attach to which VS Code window?",
                    labels,
                );
                if (!picked) return;
                const index = labels.indexOf(picked);
                if (index < 0) return;
                server = servers[index]!;
            }

            const hello = {
                sessionId:
                    ctx.sessionManager.getSessionId?.() ??
                    `process-${process.pid}`,
                piCwd: ctx.cwd,
                sessionFile: ctx.sessionManager.getSessionFile?.() ?? null,
                name: null as string | null,
            };

            try {
                await run(service().connect(server, hello, makeCallbacks()));
                setAttachedStatus();
                ctx.ui.notify("Attached to VS Code.", "info");
            } catch (error) {
                if (error instanceof BridgeRejectedError) {
                    ctx.ui.notify(error.reason, "warning");
                    return;
                }
                if (error instanceof BridgeIoError) {
                    ctx.ui.notify(error.message, "warning");
                    return;
                }
                ctx.ui.notify(
                    error instanceof Error ? error.message : String(error),
                    "warning",
                );
            }
        },
    });

    pi.registerCommand("vscode-disconnect", {
        description: "Detach from the VS Code bridge",
        handler: async (_args, ctx) => {
            sessionContext = ctx;
            const attached = await run(service().current);
            if (!attached) {
                ctx.ui.notify("Not attached to VS Code.", "info");
                return;
            }
            await run(service().disconnect("disconnect"));
            clearStatus();
            ctx.ui.notify("Detached from VS Code.", "info");
        },
    });

    pi.registerCommand("vscode-status", {
        description: "Show VS Code bridge attachment status",
        handler: async (_args, ctx) => {
            sessionContext = ctx;
            const attached = await run(service().current);
            if (!attached) {
                ctx.ui.notify("Not attached.", "info");
                return;
            }
            const workspace =
                attached.workspaceFolders[0] ?? attached.socketPath;
            ctx.ui.notify(
                `Attached to VS Code (pid ${attached.serverPid}) — workspace: ${workspace}`,
                "info",
            );
        },
    });
}
