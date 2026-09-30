import assert from "node:assert/strict";
import test from "node:test";
import { hidePiAuthFile, isolateProviderEnv, stubPiAuthData } from "./helpers.ts";
import {
  availableFetchProviders,
  availableSearchProviders,
  DEFAULT_BRAVE_API_URL,
  DEFAULT_PARALLEL_API_URL,
  DEFAULT_TINYFISH_API_URL,
  DEFAULT_TINYFISH_FETCH_URL,
  FETCH_PROVIDER_ORDER,
  getProviderStatuses,
  loadProviderKey,
  resolveBraveConfig,
  resolveFetchChain,
  resolveParallelConfig,
  resolveSearchChain,
  resolveTinyfishConfig,
  resolveTinyfishFetchUrl,
  SEARCH_PROVIDER_ORDER,
} from "../lib/config.ts";
import type { WebSearchConfig } from "../lib/types.ts";

isolateProviderEnv();

const KEYED = [
  {
    name: "brave",
    keyEnv: "BRAVE_API_KEY",
    urlEnv: "BRAVE_BASE_URL",
    authId: "websearch-brave",
    defaultUrl: DEFAULT_BRAVE_API_URL,
    resolve: resolveBraveConfig,
  },
  {
    name: "parallel",
    keyEnv: "PARALLEL_API_KEY",
    urlEnv: "PARALLEL_BASE_URL",
    authId: "websearch-parallel",
    defaultUrl: DEFAULT_PARALLEL_API_URL,
    resolve: resolveParallelConfig,
  },
  {
    name: "tinyfish",
    keyEnv: "TINYFISH_API_KEY",
    urlEnv: "TINYFISH_BASE_URL",
    authId: "websearch-tinyfish",
    defaultUrl: DEFAULT_TINYFISH_API_URL,
    resolve: resolveTinyfishConfig,
  },
] as const;

for (const p of KEYED) {
  test(`${p.name}: unconfigured without a key`, (t) => {
    t.after(hidePiAuthFile());
    assert.equal(p.resolve({}), null);
  });

  test(`${p.name}: key from the environment, trimmed, with the default endpoint`, (t) => {
    t.after(hidePiAuthFile());
    process.env[p.keyEnv] = "  env-key  ";
    assert.deepEqual(p.resolve({}), {
      apiKey: "env-key",
      baseUrl: p.defaultUrl,
      source: `${p.keyEnv} env`,
    });
  });

  test(`${p.name}: key stored by /websearch-auth, and the environment wins over it`, (t) => {
    t.after(stubPiAuthData({ [p.authId]: { type: "api_key", key: " stored-key " } }));
    assert.equal(loadProviderKey(p.name), "stored-key");
    assert.deepEqual(p.resolve({}), {
      apiKey: "stored-key",
      baseUrl: p.defaultUrl,
      source: "~/.pi/agent/auth.json",
    });

    process.env[p.keyEnv] = "env-key";
    assert.equal(p.resolve({})?.apiKey, "env-key");
    assert.equal(p.resolve({})?.source, `${p.keyEnv} env`);
  });

  test(`${p.name}: endpoint precedence is environment, then config file, then default`, (t) => {
    t.after(hidePiAuthFile());
    process.env[p.keyEnv] = "key";
    const config: WebSearchConfig = { [p.name]: { baseUrl: "https://config.example/" } };

    assert.equal(p.resolve(config)?.baseUrl, "https://config.example/");

    process.env[p.urlEnv] = "  https://env.example/  ";
    assert.equal(p.resolve(config)?.baseUrl, "https://env.example/");

    process.env[p.urlEnv] = "   ";
    assert.equal(
      p.resolve(config)?.baseUrl,
      "https://config.example/",
      "a blank variable is ignored",
    );
  });
}

test("TinyFish fetch endpoint: environment, then config file, then default", () => {
  assert.equal(resolveTinyfishFetchUrl({}), DEFAULT_TINYFISH_FETCH_URL);

  const config: WebSearchConfig = { tinyfish: { fetchUrl: " https://config.example/fetch " } };
  assert.equal(resolveTinyfishFetchUrl(config), "https://config.example/fetch");

  process.env.TINYFISH_FETCH_URL = "https://env.example/fetch";
  assert.equal(resolveTinyfishFetchUrl(config), "https://env.example/fetch");
});

test("getProviderStatuses reports Brave, Parallel and TinyFish credentials and endpoints", (t) => {
  t.after(hidePiAuthFile());
  process.env.BRAVE_API_KEY = "b";
  process.env.TINYFISH_API_KEY = "t";

  const byName = new Map(getProviderStatuses().map((status) => [status.name, status]));
  assert.deepEqual(
    [byName.get("brave"), byName.get("parallel"), byName.get("tinyfish")].map((s) => [
      s?.configured,
      s?.source,
      s?.baseUrl,
    ]),
    [
      [true, "BRAVE_API_KEY env", DEFAULT_BRAVE_API_URL],
      [false, undefined, undefined],
      [true, "TINYFISH_API_KEY env", DEFAULT_TINYFISH_API_URL],
    ],
  );
});

// ------------------------------------------------------------------ chains

test("the key-only providers trail the canonical orders, Brave for search only", () => {
  assert.deepEqual(SEARCH_PROVIDER_ORDER.slice(-4), ["monid", "brave", "parallel", "tinyfish"]);
  assert.deepEqual(FETCH_PROVIDER_ORDER.slice(-3), ["parallel", "tinyfish", "direct"]);
  assert.equal(FETCH_PROVIDER_ORDER.includes("brave" as never), false);
});

/** No keyless Firecrawl and no stored logins: only what a test configures is in the chains. */
function bareEnvironment(t: { after: (fn: () => void) => void }): void {
  t.after(hidePiAuthFile());
  process.env.FIRECRAWL_KEYLESS = "0";
}

test("only providers with a key join the chains, in canonical order", (t) => {
  bareEnvironment(t);
  assert.deepEqual(availableSearchProviders({}), ["ollama"]);
  assert.deepEqual(availableFetchProviders({}), ["direct"]);

  process.env.TINYFISH_API_KEY = "t";
  process.env.BRAVE_API_KEY = "b";
  assert.deepEqual(availableSearchProviders({}), ["ollama", "brave", "tinyfish"]);
  assert.deepEqual(availableFetchProviders({}), ["tinyfish", "direct"]);

  process.env.PARALLEL_API_KEY = "p";
  assert.deepEqual(resolveSearchChain(undefined, {}), ["ollama", "brave", "parallel", "tinyfish"]);
  assert.deepEqual(resolveFetchChain(undefined, {}), ["parallel", "tinyfish", "direct"]);
});

test("saved orders and a preferred provider are honoured for the new providers", (t) => {
  bareEnvironment(t);
  process.env.BRAVE_API_KEY = "b";
  process.env.PARALLEL_API_KEY = "p";
  process.env.TINYFISH_API_KEY = "t";

  assert.deepEqual(resolveSearchChain(undefined, { searchOrder: ["tinyfish", "brave"] }), [
    "tinyfish",
    "brave",
    "ollama",
    "parallel",
  ]);
  assert.deepEqual(resolveSearchChain("parallel", {}), ["parallel", "ollama", "brave", "tinyfish"]);
  assert.deepEqual(resolveFetchChain(undefined, { fetchProvider: "tinyfish" }), [
    "tinyfish",
    "parallel",
    "direct",
  ]);
});

test("a saved fetch order cannot smuggle in Brave, which has no fetch endpoint", (t) => {
  bareEnvironment(t);
  process.env.BRAVE_API_KEY = "b";
  process.env.PARALLEL_API_KEY = "p";

  const config = { fetchOrder: ["brave", "parallel"] } as unknown as WebSearchConfig;
  assert.deepEqual(resolveFetchChain(undefined, config), ["parallel", "direct"]);
});
