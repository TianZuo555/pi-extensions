import assert from "node:assert/strict";
import test from "node:test";
import {
  WebFetchParams,
  WebSearchParams,
} from "../lib/tools.ts";

test("WebSearchParams schema contains only query and numResults", () => {
  const properties = WebSearchParams.properties;
  const propNames = Object.keys(properties);
  assert.deepEqual(propNames.sort(), ["numResults", "query"]);
  assert.equal(properties.query.type, "string");
  assert.equal(properties.numResults.type, "number");
});

test("WebFetchParams schema contains only url and raw", () => {
  const properties = WebFetchParams.properties;
  const propNames = Object.keys(properties);
  assert.deepEqual(propNames.sort(), ["raw", "url"]);
  assert.equal(properties.url.type, "string");
  assert.equal(properties.raw.type, "boolean");
});
