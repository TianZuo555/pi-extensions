import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hidePiAuthFile, hideStoredConfig, isolateProviderEnv } from "./helpers.ts";
import webSearchExtension from "../index.ts";

isolateProviderEnv();

type Handler = (args: string, ctx: unknown) => Promise<void>;

/** Load the extension against a fake pi, run one slash command, return what it told the user. */
async function runCommand(name: string, ctx: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>();
  const pi = {
    registerTool() {},
    registerCommand(commandName: string, options: { handler: Handler }) {
      handlers.set(commandName, options.handler);
    },
    on() {},
  } as unknown as ExtensionAPI;
  webSearchExtension(pi);

  const handler = handlers.get(name);
  assert.ok(handler, `/${name} was not registered`);
  const notices: Array<{ message: string; level: string }> = [];
  const ui = { notify: (message: string, level: string) => notices.push({ message, level }) };
  await handler("", { hasUI: false, mode: "print", ui, ...ctx });
  return notices;
}

test("/websearch-auth without a UI names every API-key variable", async () => {
  const [notice] = await runCommand("websearch-auth");
  assert.equal(notice.level, "warning");
  for (const env of [
    "DEEPSEEK_API_KEY",
    "EXA_API_KEY",
    "FIRECRAWL_API_KEY",
    "TAVILY_API_KEY",
    "MONID_API_KEY",
    "BRAVE_API_KEY",
    "PARALLEL_API_KEY",
    "TINYFISH_API_KEY",
    "OLLAMA_API_KEY",
  ]) {
    assert.match(notice.message, new RegExp(`\\b${env}\\b`), `${env} is not mentioned`);
  }
});

test("/web-search reports Brave, Parallel and TinyFish with their chains", async (t) => {
  t.after(hidePiAuthFile());
  t.after(hideStoredConfig());
  process.env.BRAVE_API_KEY = "brave-key";
  process.env.PARALLEL_API_KEY = "par-key";
  process.env.TINYFISH_API_KEY = "tf-key";

  const [notice] = await runCommand("web-search");
  const lines = notice.message.split("\n");

  const searchChain = lines.find((line) => line.startsWith("search chain:")) ?? "";
  const fetchChain = lines.find((line) => line.startsWith("fetch chain:")) ?? "";
  assert.match(searchChain, /monid|ollama/, "the key-only providers trail the chain");
  assert.match(searchChain, /brave → parallel → tinyfish$/);
  assert.match(fetchChain, /parallel → tinyfish → direct$/);
  assert.doesNotMatch(fetchChain, /brave/, "Brave has no fetch endpoint");

  for (const [name, env] of [
    ["brave", "BRAVE_API_KEY"],
    ["parallel", "PARALLEL_API_KEY"],
    ["tinyfish", "TINYFISH_API_KEY"],
  ]) {
    const line = lines.find((l) => l.includes(`${name} `) && l.includes("✓"));
    assert.ok(line?.includes(`${env} env`), `${name} should be reported as configured via ${env}`);
  }
});

test("/web-search reports the new providers as unconfigured without keys", async (t) => {
  t.after(hidePiAuthFile());
  t.after(hideStoredConfig());

  const [notice] = await runCommand("web-search");
  for (const name of ["brave", "parallel", "tinyfish"]) {
    assert.ok(
      notice.message
        .split("\n")
        .some((l) => l.startsWith(`${name} `) && l.includes("• unconfigured")),
      `${name} should be listed as unconfigured`,
    );
  }
  const searchChain = notice.message.split("\n").find((l) => l.startsWith("search chain:")) ?? "";
  assert.doesNotMatch(searchChain, /brave|parallel|tinyfish/);
});
