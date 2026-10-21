/**
 * Pi Aliases Extension
 *
 * Registers command aliases that show in autocomplete:
 *   /clear → /new  (start a new session)
 *   /exit  → /quit (exit pi)
 *
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// /clear → /new
	pi.registerCommand("clear", {
		description: "→ /new · Start a new session",
		handler: async (_args, ctx) => {
			await ctx.newSession();
		},
	});

	// /exit → /quit
	pi.registerCommand("exit", {
		description: "→ /quit · Exit pi",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}
