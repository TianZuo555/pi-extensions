import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

let importId = 0;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-auth-"));
  const home = path.join(root, "home");
  const defaultDir = path.join(home, ".pi", "agent");
  fs.mkdirSync(home);
  const homedirMock = t.mock.method(os, "homedir", () => home);
  syncBuiltinESMExports();
  const previousEnv = new Map();
  t.after(() => {
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    homedirMock.mock.restore();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function env(name, value) {
    if (!previousEnv.has(name)) previousEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  env("PI_CODING_AGENT_DIR", undefined);
  env("DEEPSEEK_API_KEY", undefined);

  function writeAuth(dir, entries) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "auth.json");
    fs.writeFileSync(file, JSON.stringify(entries));
    return file;
  }

  // Each import resolves the agent directory after this test's environment is set.
  const load = () => import(`../lib/auth.ts?test=${++importId}`);
  return { root, home, defaultDir, env, writeAuth, load };
}

const deepseekEntry = { deepseek: { type: "api_key", key: "deepseek-test-key" } };

test("DeepSeek resolves a custom agent directory with no default file or env key", async (t) => {
  const f = fixture(t);
  const agentDir = path.join(f.root, "custom-agent");
  const file = f.writeAuth(agentDir, deepseekEntry);
  f.env("PI_CODING_AGENT_DIR", agentDir);
  assert.equal(fs.existsSync(path.join(f.defaultDir, "auth.json")), false);
  assert.equal(process.env.DEEPSEEK_API_KEY, undefined);

  const auth = await f.load();
  assert.equal(auth.hasDeepSeekLoginInfo(), true);
  assert.deepEqual(auth.resolveDeepSeekToken(), { token: "deepseek-test-key", source: file });
});

test("DeepSeek resolves the default directory when PI_CODING_AGENT_DIR is unset", async (t) => {
  const f = fixture(t);
  const file = f.writeAuth(f.defaultDir, deepseekEntry);
  const auth = await f.load();
  assert.equal(auth.hasDeepSeekLoginInfo(), true);
  assert.deepEqual(auth.resolveDeepSeekToken(), { token: "deepseek-test-key", source: file });
});

test("custom auth takes precedence over default auth and DEEPSEEK_API_KEY", async (t) => {
  const f = fixture(t);
  f.writeAuth(f.defaultDir, { deepseek: { type: "api_key", key: "default-key" } });
  const agentDir = path.join(f.root, "custom-agent");
  const file = f.writeAuth(agentDir, deepseekEntry);
  f.env("PI_CODING_AGENT_DIR", agentDir);
  f.env("DEEPSEEK_API_KEY", "env-key");
  const auth = await f.load();
  assert.deepEqual(auth.resolveDeepSeekToken(), { token: "deepseek-test-key", source: file });
});

test("Pi expands a tilde-prefixed agent directory", async (t) => {
  const f = fixture(t);
  const file = f.writeAuth(path.join(f.home, "custom-agent"), deepseekEntry);
  f.env("PI_CODING_AGENT_DIR", "~/custom-agent");
  const auth = await f.load();
  assert.deepEqual(auth.resolveDeepSeekToken(), { token: "deepseek-test-key", source: file });
});

test("missing custom auth does not fall back to default credentials", async (t) => {
  const f = fixture(t);
  f.writeAuth(f.defaultDir, deepseekEntry);
  const agentDir = path.join(f.root, "missing-agent");
  f.env("PI_CODING_AGENT_DIR", agentDir);
  const auth = await f.load();
  assert.equal(auth.hasDeepSeekLoginInfo(), false);
  assert.equal(auth.resolveDeepSeekToken(), undefined);

  f.env("DEEPSEEK_API_KEY", "env-key");
  assert.deepEqual(auth.resolveDeepSeekToken(), { token: "env-key", source: "$DEEPSEEK_API_KEY" });
  assert.equal(auth.hasDeepSeekLoginInfo(), true);

  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, "auth.json"), "invalid json");
  assert.deepEqual(auth.resolveDeepSeekToken(), { token: "env-key", source: "$DEEPSEEK_API_KEY" });
});

test("all shared auth readers use the custom agent directory", async (t) => {
  const f = fixture(t);
  const agentDir = path.join(f.root, "custom-agent");
  const file = f.writeAuth(agentDir, {
    "openai-codex": { type: "oauth", access: "codex-access", refresh: "codex-refresh" },
    "github-copilot": { type: "oauth", refresh: "github-token" },
    zai: { type: "api_key", key: "zai-key" },
    "zai-coding-cn": { type: "api_key", key: "zai-cn-key" },
    xiaomi: { type: "api_key", key: "xiaomi-model-key" },
    "xiaomi-console": { type: "cookie", key: "xiaomi-cookie" },
  });
  f.env("PI_CODING_AGENT_DIR", agentDir);
  const auth = await f.load();
  assert.equal(auth.hasCodexLoginInfo(), true);
  assert.deepEqual(await auth.resolveCodexToken({}), { token: "codex-access", source: file });
  for (const [hasLogin, resolve, token] of [
    [auth.hasCopilotLoginInfo, auth.resolveCopilotToken, "github-token"],
    [auth.hasZaiLoginInfo, auth.resolveZaiToken, "zai-key"],
    [auth.hasZaiCnLoginInfo, auth.resolveZaiCnToken, "zai-cn-key"],
    [auth.hasXiaomiLoginInfo, auth.resolveXiaomiToken, "xiaomi-cookie"],
  ]) {
    assert.equal(hasLogin(), true);
    assert.deepEqual(resolve(), { token, source: file });
  }
  assert.equal(auth.hasXiaomiModelLoginInfo(), true);
});
