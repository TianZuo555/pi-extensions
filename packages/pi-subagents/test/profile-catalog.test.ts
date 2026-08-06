import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ProfileCatalog, SAFE_AGENT_ARG_PATTERN } from "../lib/profile-catalog.ts";
import {
  REPORT_MAX_BYTES,
  TASK_MAX_LENGTH,
  TRUNCATION_MARKER,
  truncateText,
  truncateUtf8,
} from "../lib/domain.ts";

function isolatedAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-catalog-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  return dir;
}

function writeAgentProfile(agentDir: string, filename: string, frontmatter: string, body = "Test agent."): void {
  fs.writeFileSync(
    path.join(agentDir, "agents", filename),
    `---
${frontmatter}
---
${body}
`,
    "utf8",
  );
}

describe("ProfileCatalog", () => {
  it("loads builtin profiles with default maxTurns", () => {
    const agentDir = isolatedAgentDir();
    const catalog = new ProfileCatalog(process.cwd(), agentDir);
    const scout = catalog.resolve("scout");
    assert.equal(scout.qualifiedId, "builtin/scout");
    assert.equal(scout.workspace, "shared-readonly");
    assert.equal(scout.maxTurns, 8);
    assert.equal(scout.kind, "pi");
    assert.equal(scout.backend, "auto");
    assert.deepEqual(scout.agentArgs, []);
    const worker = catalog.resolve("builtin/worker");
    assert.equal(worker.workspace, "worktree");
    assert.ok(worker.tools.includes("write"));
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("lists qualified ids", () => {
    const agentDir = isolatedAgentDir();
    const catalog = new ProfileCatalog(process.cwd(), agentDir);
    const ids = catalog.listQualifiedIds();
    assert.ok(ids.includes("builtin/scout"));
    assert.ok(ids.includes("builtin/worker"));
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("loads user profile with tools * and inferred shared-write", () => {
    const agentDir = isolatedAgentDir();
    const agentsDir = path.join(agentDir, "agents");
    fs.writeFileSync(
      path.join(agentsDir, "executor.md"),
      `---
name: executor
tools: "*"
description: full tool access
---
You are an executor.
`,
      "utf8",
    );

    const catalog = new ProfileCatalog(process.cwd(), agentDir);
    const profile = catalog.resolve("user/executor");
    assert.equal(profile.workspace, "shared-write");
    assert.ok(profile.tools.includes("write"));
    assert.equal(catalog.getLoadDiagnostics().length, 0);

    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("records skip diagnostics without console noise", () => {
    const agentDir = isolatedAgentDir();
    const agentsDir = path.join(agentDir, "agents");
    fs.writeFileSync(
      path.join(agentsDir, "bad.md"),
      `---
name: bad
tools: teleport
---
Broken
`,
      "utf8",
    );

    const catalog = new ProfileCatalog(process.cwd(), agentDir);
    const diags = catalog.getLoadDiagnostics();
    assert.equal(diags.length, 1);
    assert.match(diags[0], /teleport/);

    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("defaults kind to pi and parses explicit valid kind", () => {
    const agentDir = isolatedAgentDir();
    writeAgentProfile(agentDir, "codex-agent.md", `name: codex-agent\nkind: codex`);
    const catalog = new ProfileCatalog(process.cwd(), agentDir);
    const profile = catalog.resolve("user/codex-agent");
    assert.equal(profile.kind, "codex");
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("normalizes cursor-agent alias to cursor", () => {
    const agentDir = isolatedAgentDir();
    writeAgentProfile(agentDir, "cursor-alias.md", `name: cursor-alias\nkind: cursor-agent`);
    const catalog = new ProfileCatalog(process.cwd(), agentDir);
    const profile = catalog.resolve("user/cursor-alias");
    assert.equal(profile.kind, "cursor");
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("skips unknown kind with a diagnostic", () => {
    const agentDir = isolatedAgentDir();
    writeAgentProfile(agentDir, "bad-kind.md", `name: bad-kind\nkind: notarealkind`);
    const catalog = new ProfileCatalog(process.cwd(), agentDir);
    const diags = catalog.getLoadDiagnostics();
    assert.equal(diags.length, 1);
    assert.match(diags[0], /notarealkind/);
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("defaults backend to auto and accepts valid values", () => {
    const agentDir = isolatedAgentDir();
    writeAgentProfile(agentDir, "rpc-only.md", `name: rpc-only\nbackend: rpc`);
    writeAgentProfile(agentDir, "herdr-only.md", `name: herdr-only\nbackend: herdr`);
    const catalog = new ProfileCatalog(process.cwd(), agentDir);
    assert.equal(catalog.resolve("scout").backend, "auto");
    assert.equal(catalog.resolve("user/rpc-only").backend, "rpc");
    assert.equal(catalog.resolve("user/herdr-only").backend, "herdr");
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("skips invalid backend with a diagnostic", () => {
    const agentDir = isolatedAgentDir();
    writeAgentProfile(agentDir, "bad-backend.md", `name: bad-backend\nbackend: websocket`);
    const catalog = new ProfileCatalog(process.cwd(), agentDir);
    const diags = catalog.getLoadDiagnostics();
    assert.equal(diags.length, 1);
    assert.match(diags[0], /websocket/);
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("parses agentArgs from string and YAML list", () => {
    const agentDir = isolatedAgentDir();
    writeAgentProfile(agentDir, "string-args.md", `name: string-args\nagentArgs: --plan --model gpt-4`);
    writeAgentProfile(
      agentDir,
      "list-args.md",
      `name: list-args\nagentArgs:\n  - --plan\n  - --verbose`,
    );
    const catalog = new ProfileCatalog(process.cwd(), agentDir);
    assert.deepEqual(catalog.resolve("user/string-args").agentArgs, ["--plan", "--model", "gpt-4"]);
    assert.deepEqual(catalog.resolve("user/list-args").agentArgs, ["--plan", "--verbose"]);
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("rejects unsafe agentArgs with diagnostics", () => {
    const agentDir = isolatedAgentDir();
    const agentsDir = path.join(agentDir, "agents");
    const unsafeCases: { file: string; agentArgs: string }[] = [
      { file: "semi.md", agentArgs: "--plan;rm" },
      { file: "backtick.md", agentArgs: "`whoami`" },
      { file: "dollar.md", agentArgs: "${HOME}" },
      { file: "pipe.md", agentArgs: "a|b" },
      { file: "space-quote.md", agentArgs: '--foo "bar"' },
    ];
    for (const { file, agentArgs } of unsafeCases) {
      writeAgentProfile(agentDir, file, `name: ${path.basename(file, ".md")}\nagentArgs: ${agentArgs}`);
    }
    const catalog = new ProfileCatalog(process.cwd(), agentDir);
    const diags = catalog.getLoadDiagnostics();
    assert.equal(diags.length, unsafeCases.length);
    for (const { agentArgs } of unsafeCases) {
      assert.ok(
        diags.some((d) => d.includes(agentArgs) || d.includes("unsafe characters")),
        `expected diagnostic for agentArgs: ${agentArgs}`,
      );
    }
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("SAFE_AGENT_ARG_PATTERN blocks shell injection metacharacters", () => {
    assert.equal(SAFE_AGENT_ARG_PATTERN.test("--plan"), true);
    assert.equal(SAFE_AGENT_ARG_PATTERN.test("--model"), true);
    assert.equal(SAFE_AGENT_ARG_PATTERN.test("a;b"), false);
    assert.equal(SAFE_AGENT_ARG_PATTERN.test("`id`"), false);
    assert.equal(SAFE_AGENT_ARG_PATTERN.test("${PATH}"), false);
    assert.equal(SAFE_AGENT_ARG_PATTERN.test("a|b"), false);
    assert.equal(SAFE_AGENT_ARG_PATTERN.test('"quoted"'), false);
    assert.equal(SAFE_AGENT_ARG_PATTERN.test("foo bar"), false);
  });
});

describe("truncation", () => {
  it("marks UTF-16 truncation for task/context limits", () => {
    const long = "a".repeat(TASK_MAX_LENGTH + 10);
    const out = truncateText(long, TASK_MAX_LENGTH);
    assert.ok(out.endsWith(TRUNCATION_MARKER));
    assert.ok(out.length <= TASK_MAX_LENGTH);
  });

  it("marks byte truncation for reports", () => {
    const long = "é".repeat(REPORT_MAX_BYTES);
    const out = truncateUtf8(long, 64);
    assert.ok(out.endsWith(TRUNCATION_MARKER));
    assert.ok(Buffer.byteLength(out, "utf8") <= 64);
  });
});
