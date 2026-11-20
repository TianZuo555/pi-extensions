import assert from "node:assert/strict";
import test from "node:test";
import {
  effortOf,
  magpieFailure,
  modelOf,
  parseAccounts,
  parseIssuedKey,
  readReply,
} from "../lib/magpie.ts";

test("parseAccounts keeps the accounts magpie has on", () => {
  const stdout = JSON.stringify([
    { agent: "codex", user: "a@example.com", plan: "plus", on: true },
    { agent: "codex", user: "b@example.com", plan: "pro", on: false },
    { agent: "codex", user: "", on: true },
    "nonsense",
  ]);
  assert.deepEqual(parseAccounts(stdout), [{ user: "a@example.com", plan: "plus" }]);
});

test("parseAccounts survives an odd payload", () => {
  assert.deepEqual(parseAccounts("[]"), []);
  assert.deepEqual(parseAccounts("{}"), []);
});

test("parseIssuedKey reads the key and refuses an empty one", () => {
  assert.equal(
    parseIssuedKey(JSON.stringify({ id: "x", key: "sk-magpie-key-abc" })),
    "sk-magpie-key-abc",
  );
  assert.throws(() => parseIssuedKey(JSON.stringify({ id: "x" })), /returned no key/u);
});

test("readReply reads both content shapes and the usage", () => {
  const plain = readReply({
    choices: [{ message: { content: "答案：21颗" } }],
    usage: {
      prompt_tokens: 5422,
      completion_tokens: 773,
      completion_tokens_details: { reasoning_tokens: 468 },
    },
  });
  assert.equal(plain.text, "答案：21颗");
  assert.equal(plain.reasoningTokens, 468);
  assert.equal(plain.promptTokens, 5422);

  const parts = readReply({
    choices: [{ message: { content: [{ type: "text", text: "答案：" }, { text: "21颗" }] } }],
  });
  assert.equal(parts.text, "答案：21颗");
  assert.equal(parts.reasoningTokens, undefined);

  const empty = readReply({});
  assert.equal(empty.text, "");
});

test("modelOf and effortOf take the environment, then their own default", () => {
  assert.equal(modelOf({}), "codex/gpt-6.2-sol");
  assert.equal(modelOf({ PI_SMART_MODEL: "codex/gpt-6.1-terra" }), "codex/gpt-6.1-terra");
  assert.equal(modelOf({ PI_SMART_MODEL: "  " }), "codex/gpt-6.2-sol");
  assert.equal(effortOf({}), "high");
  assert.equal(effortOf({ PI_SMART_EFFORT: "xhigh" }), "xhigh");
});

test("magpieFailure names what magpie said, not the command line", () => {
  const refused = Object.assign(
    new Error(
      "Command failed: /Applications/magpie.app/Contents/MacOS/magpie gateway-key issue --ttl 10m --accounts codex/nobody@example.com --json",
    ),
    { stderr: '\n  magpie: Codex has no account "nobody@example.com"\n' },
  );
  assert.equal(magpieFailure(refused), 'magpie: Codex has no account "nobody@example.com"');
  assert.match(
    magpieFailure(new Error("Command failed: magpie status --json")),
    /magpie exited with an error/u,
  );
  assert.equal(magpieFailure(new Error("boom")), "boom");
});
