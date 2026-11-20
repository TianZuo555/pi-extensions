// The magpie side: which accounts exist, a key pinned to one of them, and the
// probe itself.
//
// Only magpie can send a request to one named account, so a probe issues a
// short-lived gateway key held to that account, then calls the gateway's
// OpenAI-compatible endpoint. The key lives ten minutes and is never written
// anywhere.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseAnswer, type Verdict, verdictOf } from "./answer.ts";
import { PUZZLE_PROMPT } from "./prompt.ts";

const exec = promisify(execFile);

export const DEFAULT_MODEL = "codex/gpt-6.2-sol";
export const DEFAULT_EFFORT = "high";
export const DEFAULT_TIMEOUT_MS = 180_000;

const KEY_TTL = "10m";
const KEY_NAME = "smart-gpt";
const MAX_TOKENS = 16_000;

// `magpie` relies on PATH; the rest are where the script installer, Homebrew
// and the signed macOS app put it. PI_SMART_MAGPIE_BIN overrides discovery.
const MAGPIE_BINARIES = [
  "magpie",
  path.join(os.homedir(), ".local", "bin", "magpie"),
  "/usr/local/bin/magpie",
  "/opt/homebrew/bin/magpie",
  "/Applications/magpie.app/Contents/MacOS/magpie",
];

export interface Account {
  user: string;
  plan?: string;
}

export interface ProbeRun {
  at: string;
  account: string;
  model: string;
  effort: string;
  verdict: Verdict | "error";
  answer?: number;
  reasoningTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs: number;
  text?: string;
  error?: string;
}

export interface ProbeSettings {
  model: string;
  effort: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** The model to ask: PI_SMART_MODEL, else codex/gpt-6.2-sol. */
export function modelOf(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_SMART_MODEL?.trim() || DEFAULT_MODEL;
}

/** The thinking level: PI_SMART_EFFORT, else high. Change it only if the
 * account's earlier runs are discarded with it: the level is the ruler. */
export function effortOf(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_SMART_EFFORT?.trim() || DEFAULT_EFFORT;
}

/** The magpie executable, or undefined when magpie is not installed. */
export async function magpieBin(): Promise<string | undefined> {
  const override = process.env.PI_SMART_MAGPIE_BIN?.trim();
  const candidates = override ? [override] : MAGPIE_BINARIES;
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && !fs.existsSync(candidate)) continue;
    try {
      await exec(candidate, ["--version"], { timeout: 8_000 });
      return candidate;
    } catch {
      // Not this one: try the next install location.
    }
  }
  return undefined;
}

/** What magpie said when it refused, without the command line execFile puts
 * in front of it. */
export function magpieFailure(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === "string") {
    const line = stderr
      .split("\n")
      .map((row) => row.trim())
      .filter((row) => row !== "")
      .at(-1);
    if (line) return line.slice(0, 200);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Command failed")) {
    return "magpie exited with an error; run `magpie accounts codex` to check it";
  }
  return message.slice(0, 200);
}

/** The accounts to probe: every one magpie has switched on. */
export function parseAccounts(stdout: string): Account[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return [];
  const accounts: Account[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as { user?: unknown; plan?: unknown; on?: unknown };
    if (typeof row.user !== "string" || row.user === "") continue;
    if (row.on === false) continue;
    accounts.push(
      typeof row.plan === "string" ? { user: row.user, plan: row.plan } : { user: row.user },
    );
  }
  return accounts;
}

/** The gateway key a `magpie gateway-key issue --json` prints. */
export function parseIssuedKey(stdout: string): string {
  const parsed: unknown = JSON.parse(stdout);
  const key =
    typeof parsed === "object" && parsed !== null ? (parsed as { key?: unknown }).key : undefined;
  if (typeof key !== "string" || key === "")
    throw new Error("magpie gateway-key issue returned no key");
  return key;
}

/** The reply's text and its usage, as a chat completion reports them. */
export function readReply(reply: unknown): {
  text: string;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
} {
  const body = reply as {
    choices?: { message?: { content?: unknown } }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };
  const content = body.choices?.[0]?.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              typeof part === "object" && part !== null && "text" in part ? String(part.text) : "",
            )
            .join("")
        : "";
  return {
    text,
    promptTokens: body.usage?.prompt_tokens,
    completionTokens: body.usage?.completion_tokens,
    reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens,
  };
}

export async function accountList(bin: string, agent = "codex"): Promise<Account[]> {
  const { stdout } = await exec(bin, ["accounts", agent, "--json"], {
    timeout: 30_000,
    maxBuffer: 4 << 20,
  });
  return parseAccounts(stdout);
}

/** The gateway's address: PI_SMART_GATEWAY, else what magpie reports. */
export async function gatewayUrl(bin: string): Promise<string> {
  const override = process.env.PI_SMART_GATEWAY?.trim();
  if (override) return override.replace(/\/+$/, "");
  let stdout: string;
  try {
    ({ stdout } = await exec(bin, ["status", "--json"], { timeout: 15_000, maxBuffer: 1 << 20 }));
  } catch (error) {
    throw new Error(magpieFailure(error));
  }
  const status = JSON.parse(stdout) as { url?: unknown; running?: unknown };
  if (typeof status.url !== "string" || status.url === "") {
    throw new Error("magpie is not serving a gateway; start magpie, then probe again");
  }
  return status.url.replace(/\/+$/, "");
}

async function issueKey(bin: string, account: string, agent = "codex"): Promise<string> {
  try {
    const { stdout } = await exec(
      bin,
      [
        "gateway-key",
        "issue",
        "--ttl",
        KEY_TTL,
        "--name",
        KEY_NAME,
        "--accounts",
        `${agent}/${account}`,
        "--json",
      ],
      { timeout: 30_000, maxBuffer: 1 << 20 },
    );
    return parseIssuedKey(stdout);
  } catch (error) {
    throw new Error(magpieFailure(error));
  }
}

function failure(
  account: string,
  settings: ProbeSettings,
  error: string,
  startedAt: string,
  at: number,
): ProbeRun {
  return {
    at: startedAt,
    account,
    model: settings.model,
    effort: settings.effort,
    verdict: "error",
    latencyMs: Date.now() - at,
    error,
  };
}

/** Ask one account the puzzle, once. */
export async function probe(
  bin: string,
  url: string,
  account: string,
  settings: ProbeSettings,
): Promise<ProbeRun> {
  const startedAt = new Date().toISOString();
  const at = Date.now();
  try {
    const key = await issueKey(bin, account);
    const timeout = AbortSignal.timeout(settings.timeoutMs);
    const signal = settings.signal ? AbortSignal.any([settings.signal, timeout]) : timeout;
    const reply = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: settings.model,
        messages: [{ role: "user", content: PUZZLE_PROMPT }],
        reasoning_effort: settings.effort,
        max_tokens: MAX_TOKENS,
        stream: false,
      }),
      signal,
    });
    const latencyMs = Date.now() - at;
    if (!reply.ok) {
      const detail = (await reply.text()).slice(0, 300);
      return {
        ...failure(account, settings, `gateway answered ${reply.status}: ${detail}`, startedAt, at),
        latencyMs,
      };
    }
    const reading = readReply(await reply.json());
    const answer = parseAnswer(reading.text);
    return {
      at: startedAt,
      account,
      model: settings.model,
      effort: settings.effort,
      verdict: verdictOf(answer),
      ...(answer === undefined ? {} : { answer }),
      ...(reading.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: reading.reasoningTokens }),
      ...(reading.promptTokens === undefined ? {} : { promptTokens: reading.promptTokens }),
      ...(reading.completionTokens === undefined
        ? {}
        : { completionTokens: reading.completionTokens }),
      latencyMs,
      text: reading.text,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return failure(account, settings, reason.slice(0, 200), startedAt, at);
  }
}
