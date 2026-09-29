import assert from "node:assert/strict";
import test from "node:test";
import { isolateProviderEnv, stubFetch } from "./helpers.ts";
import { splitDomainFilter } from "../lib/domain-filter.ts";
import { searchExa } from "../lib/exa.ts";
import { searchTavily } from "../lib/tavily.ts";

isolateProviderEnv();

const FILTER = ["example.com", "docs.example.com", "-pinterest.com", "- reddit.com"];

test("searchExa maps domain filters to includeDomains and excludeDomains", async (t) => {
  process.env.EXA_API_KEY = "exa-key";
  const stub = stubFetch(() => new Response(JSON.stringify({ results: [] }), { status: 200 }));
  t.after(stub.restore);

  await searchExa("q", { domainFilter: FILTER });
  const body = stub.calls[0].body as Record<string, unknown>;
  assert.deepEqual(body.includeDomains, ["example.com", "docs.example.com"]);
  assert.deepEqual(body.excludeDomains, ["pinterest.com", "reddit.com"]);

  await searchExa("q");
  const bare = stub.calls[1].body as Record<string, unknown>;
  assert.equal("includeDomains" in bare, false);
  assert.equal("excludeDomains" in bare, false);
});

test("searchTavily maps domain filters to include_domains and exclude_domains", async (t) => {
  process.env.TAVILY_API_KEY = "tvly-key";
  const stub = stubFetch(() => new Response(JSON.stringify({ results: [] }), { status: 200 }));
  t.after(stub.restore);

  await searchTavily("q", { domainFilter: FILTER });
  const body = stub.calls[0].body as Record<string, unknown>;
  assert.deepEqual(body.include_domains, ["example.com", "docs.example.com"]);
  assert.deepEqual(body.exclude_domains, ["pinterest.com", "reddit.com"]);

  await searchTavily("q", { domainFilter: ["-pinterest.com"] });
  const onlyExcludes = stub.calls[1].body as Record<string, unknown>;
  assert.equal("include_domains" in onlyExcludes, false);
  assert.deepEqual(onlyExcludes.exclude_domains, ["pinterest.com"]);
});

test("splitDomainFilter separates inclusions from exclusions", () => {
  assert.deepEqual(splitDomainFilter(undefined), { include: [], exclude: [] });
  assert.deepEqual(splitDomainFilter([]), { include: [], exclude: [] });
  assert.deepEqual(splitDomainFilter(["a.com", "-b.com", "c.com", "- d.com"]), {
    include: ["a.com", "c.com"],
    exclude: ["b.com", "d.com"],
  });
});
