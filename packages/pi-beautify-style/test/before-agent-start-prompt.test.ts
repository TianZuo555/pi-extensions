import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import agentAutocompleteExtension from "../extensions/feature/reference/subagent.ts";
import sessionReferenceExtension from "../extensions/feature/reference/index.ts";

function install(extension: (pi: any) => void) {
	const events = new Map<string, Function>();
	extension({
		on(name: string, handler: Function) {
			events.set(name, handler);
		},
		events: { on: () => () => {} },
		registerMessageRenderer() {},
	});
	return events;
}

test("custom before_agent_start does not read a missing prompt", async () => {
	const session = install(sessionReferenceExtension);
	const subagent = install(agentAutocompleteExtension);
	const custom = { messageType: "custom", message: { content: "@session:[x] @subagent:[coder]" } };
	assert.equal(await session.get("before_agent_start")?.(custom, {}), undefined);
	assert.equal(await subagent.get("before_agent_start")?.(custom, {}), undefined);
});

test("a prompt without messageType still injects subagent references", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-prompt-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "agents", "coder.md"), "---\ndisplay_name: Coder\n---\n");
	try {
		const events = install(agentAutocompleteExtension);
		const result = await events.get("before_agent_start")?.(
			{ prompt: "please ask @subagent:[coder]", systemPrompt: "base" },
			{},
		);
		assert.match(result?.message?.content ?? "", /"coder" \(Coder\)/);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("a prompt without messageType still resolves session references", async (t) => {
	const listAll = mock.method(SessionManager, "listAll", async () => []);
	t.after(() => listAll.mock.restore());
	const events = install(sessionReferenceExtension);
	const notices: string[] = [];
	const result = await events.get("before_agent_start")?.(
		{ prompt: "include @session:[missing-ref]" },
		{
			sessionManager: { getSessionId: () => "current" },
			ui: { notify: (message: string) => notices.push(message) },
		},
	);
	assert.equal(listAll.mock.calls.length, 1);
	assert.equal(result, undefined);
	assert.ok(notices.some((message) => message.includes("not found")));
});

test("session_start does not prefetch the session store", async (t) => {
	const listAll = mock.method(SessionManager, "listAll", async () => []);
	t.after(() => listAll.mock.restore());
	const events = install(sessionReferenceExtension);
	const ctx = {
		cwd: process.cwd(),
		mode: "tui",
		ui: { notify: () => {}, addAutocompleteProvider: () => {} },
		sessionManager: {
			getSessionId: () => "current",
			getSessionFile: () => "/tmp/current.jsonl",
		},
	};

	events.get("session_start")?.({}, ctx);
	assert.equal(listAll.mock.calls.length, 0);
});
