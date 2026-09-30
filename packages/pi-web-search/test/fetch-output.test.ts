import assert from "node:assert/strict";
import fs from "node:fs";
import test, { type TestContext } from "node:test";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FETCH_PROVIDER_ORDER } from "../lib/config.ts";
import { registerTools, type WebFetchDetails, type WebFetchInput } from "../lib/tools.ts";
import type { FetchProviderName } from "../lib/types.ts";
import { createWebSearchRuntime } from "../src/runtime.ts";
import { hidePiAuthFile, hideStoredConfig, isolateProviderEnv, stubFetch } from "./helpers.ts";

isolateProviderEnv();

interface FetchTool {
  execute: (
    id: string,
    params: WebFetchInput,
    signal: AbortSignal | undefined,
  ) => Promise<AgentToolResult<WebFetchDetails>>;
}

function setupTool(t: TestContext): FetchTool {
  t.after(hidePiAuthFile());
  t.after(hideStoredConfig());
  process.env.FIRECRAWL_KEYLESS = "0";
  const runtime = createWebSearchRuntime();
  t.after(() => runtime.dispose());
  let tool: FetchTool | undefined;
  registerTools(
    {
      registerTool(definition: { name: string }) {
        if (definition.name === "web_fetch") tool = definition as unknown as FetchTool;
      },
    } as unknown as ExtensionAPI,
    runtime,
  );
  assert.ok(tool);
  return tool;
}

function outputText(result: AgentToolResult<WebFetchDetails>): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

const url = "https://example.com/article";
const body = "Page body with Unicode: 中文.";
const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

const providers: Record<
  FetchProviderName,
  { env: Record<string, string>; response: () => Response }
> = {
  firecrawl: {
    env: { FIRECRAWL_API_KEY: "fc-test" },
    response: () => json({ data: { markdown: body, metadata: { title: "Page title" } } }),
  },
  exa: {
    env: { EXA_API_KEY: "exa-test" },
    response: () => json({ results: [{ url, title: "Page title", text: body }] }),
  },
  tavily: {
    env: { TAVILY_API_KEY: "tvly-test" },
    response: () => json({ results: [{ url, raw_content: body }] }),
  },
  ollama: {
    env: { OLLAMA_HOST: "http://localhost:11434" },
    response: () => json({ title: "Page title", content: body }),
  },
  monid: {
    env: { MONID_API_KEY: "monid-test" },
    response: () =>
      json({
        status: "COMPLETED",
        output: { results: [{ url, title: "Page title", text: body }] },
      }),
  },
  parallel: {
    env: { PARALLEL_API_KEY: "par-test" },
    response: () => json({ results: [{ url, title: "Page title", full_content: body }] }),
  },
  tinyfish: {
    env: { TINYFISH_API_KEY: "tf-test" },
    response: () => json({ results: [{ url, title: "Page title", text: body }] }),
  },
  direct: {
    env: {},
    response: () => new Response(body, { headers: { "Content-Type": "text/plain" } }),
  },
};

for (const provider of FETCH_PROVIDER_ORDER) {
  test(`web_fetch exposes ${provider} in model-facing content, not just details`, async (t) => {
    const tool = setupTool(t);
    Object.assign(process.env, providers[provider].env);
    const stub = stubFetch(providers[provider].response);
    t.after(stub.restore);

    const result = await tool.execute("fetch", { url }, undefined);
    const text = outputText(result);
    assert.equal(result.details.provider, provider);
    assert.ok(text.startsWith(`Fetched via ${provider}.\n\n`), text);
    assert.ok(text.endsWith(body), "page content must be preserved");
    if (result.details.title) assert.ok(text.includes(`# ${result.details.title}\n\n`));
    assert.equal(result.details.bytes, Buffer.byteLength(text, "utf8"));
    assert.equal(stub.calls.length, 1);
  });
}

for (const provider of ["direct", "tinyfish"] as const) {
  test(`web_fetch includes ${provider} while preserving raw HTML`, async (t) => {
    const tool = setupTool(t);
    Object.assign(process.env, providers[provider].env);
    const html = "<html><body><p>Raw &amp; unchanged</p></body></html>";
    const stub = stubFetch(() =>
      provider === "direct"
        ? new Response(html, { headers: { "Content-Type": "text/html" } })
        : json({ results: [{ url, text: html }] }),
    );
    t.after(stub.restore);

    const result = await tool.execute("fetch", { url, raw: true }, undefined);
    assert.equal(outputText(result), `Fetched via ${provider}.\n\n${html}`);
    assert.equal(result.details.provider, provider);
  });
}

test("web_fetch names the successful fallback, not the failed primary", async (t) => {
  const tool = setupTool(t);
  process.env.PARALLEL_API_KEY = "par-test";
  const stub = stubFetch((call) =>
    call.url.hostname === "api.parallel.ai"
      ? new Response("unavailable", { status: 503 })
      : providers.direct.response(),
  );
  t.after(stub.restore);

  const result = await tool.execute("fetch", { url }, undefined);
  assert.equal(outputText(result), `Fetched via direct.\n\n${body}`);
  assert.equal(result.details.provider, "direct");
  assert.deepEqual(result.details.fallbackFrom, ["parallel"]);
});

test("web_fetch includes the provider alongside PDF page metadata", async (t) => {
  const tool = setupTool(t);
  const pdf = fs.readFileSync(new URL("./fixtures/hello.pdf", import.meta.url));
  const stub = stubFetch(
    () => new Response(pdf, { headers: { "Content-Type": "application/pdf" } }),
  );
  t.after(stub.restore);

  const result = await tool.execute("fetch", { url: "https://example.com/paper.pdf" }, undefined);
  const text = outputText(result);
  assert.ok(text.startsWith("Fetched via direct.\n\n"));
  assert.match(text, /Hello PDF world from the extraction fixture/);
  assert.equal(result.details.provider, "direct");
  assert.equal(result.details.pages, 2);
  assert.equal(result.details.bytes, Buffer.byteLength(text, "utf8"));
});
