/**
 * Test helpers for hiding or faking ~/.pi/agent/auth.json so provider
 * resolution tests stay hermetic on machines with real stored logins
 * (e.g. openai-codex, websearch-exa). config.ts treats a read error as
 * "no auth file" and only reads paths ending in auth.json.
 *
 * The same goes for the environment: `isolateProviderEnv()` scrubs every
 * variable the extension reads, so a developer who exports BRAVE_API_KEY (or
 * any other provider key) does not change what the tests observe.
 */
import fs from "node:fs";
import { afterEach, beforeEach } from "node:test";

/**
 * Prefixes of every provider whose environment variables the extension reads
 * (OPENAI_API_KEY, FIRECRAWL_KEYLESS, BRAVE_BASE_URL, TINYFISH_FETCH_URL, ...).
 * A new provider needs one line here: env-hygiene.test.ts fails when the source
 * reads a variable whose prefix is missing.
 */
export const PROVIDER_ENV_PREFIXES = [
  "OPENAI_",
  "DEEPSEEK_",
  "EXA_",
  "FIRECRAWL_",
  "TAVILY_",
  "MONID_",
  "OLLAMA_",
  "BRAVE_",
  "PARALLEL_",
  "TINYFISH_",
] as const;

function isProviderEnvName(name: string): boolean {
  return PROVIDER_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Provider variables currently set in the process environment. */
export function snapshotProviderEnv(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && isProviderEnvName(name)) snapshot[name] = value;
  }
  return snapshot;
}

/** Make the provider variables exactly `snapshot`: drop the rest, put these back. */
export function restoreProviderEnv(snapshot: Record<string, string>): void {
  for (const name of Object.keys(process.env)) {
    if (isProviderEnvName(name) && !(name in snapshot)) delete process.env[name];
  }
  Object.assign(process.env, snapshot);
}

/**
 * Register hooks so every test in the calling file starts with no provider
 * environment variables and gets the developer's values back afterwards.
 * Call once at the top of a test file.
 */
export function isolateProviderEnv(): void {
  let saved: Record<string, string> = {};
  beforeEach(() => {
    saved = snapshotProviderEnv();
    restoreProviderEnv({});
  });
  afterEach(() => {
    restoreProviderEnv(saved);
  });
}

function isAuthPath(path: fs.PathOrFileDescriptor | fs.PathLike): boolean {
  return String(path).endsWith("auth.json");
}

function isConfigPath(path: fs.PathOrFileDescriptor | fs.PathLike): boolean {
  const s = String(path);
  return s.endsWith("pi-web-search/config.json") || s.endsWith("web-search.json");
}

/** Make the stored web-search config invisible for the duration of a test,
 * so provider resolution does not pick up the developer machine's real
 * searchProvider/fetchProvider/order settings. */
export function hideStoredConfig(): () => void {
  const originalReadFileSync = fs.readFileSync;
  const originalExistsSync = fs.existsSync;
  fs.existsSync = ((path: fs.PathLike) =>
    isConfigPath(path) ? false : originalExistsSync(path)) as typeof fs.existsSync;
  fs.readFileSync = ((path: fs.PathOrFileDescriptor, options?: unknown) => {
    if (isConfigPath(path)) {
      throw new Error("web-search config hidden from this test");
    }
    return originalReadFileSync(path, options as Parameters<typeof originalReadFileSync>[1]);
  }) as typeof fs.readFileSync;
  return () => {
    fs.readFileSync = originalReadFileSync;
    fs.existsSync = originalExistsSync;
  };
}

/** Make auth.json invisible to config.ts for the duration of a test. */
export function hidePiAuthFile(): () => void {
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = ((path: fs.PathOrFileDescriptor, options?: unknown) => {
    if (isAuthPath(path)) {
      throw new Error("auth.json hidden from this test");
    }
    return originalReadFileSync(path, options as Parameters<typeof originalReadFileSync>[1]);
  }) as typeof fs.readFileSync;
  return () => {
    fs.readFileSync = originalReadFileSync;
  };
}

/** Serve fake auth.json contents to config.ts for the duration of a test. */
export function stubPiAuthData(data: Record<string, unknown>): () => void {
  const originalReadFileSync = fs.readFileSync;
  const originalExistsSync = fs.existsSync;
  const json = JSON.stringify(data);
  fs.existsSync = ((path: fs.PathLike) =>
    isAuthPath(path) ? true : originalExistsSync(path)) as typeof fs.existsSync;
  fs.readFileSync = ((path: fs.PathOrFileDescriptor, options?: unknown) => {
    if (isAuthPath(path)) return json;
    return originalReadFileSync(path, options as Parameters<typeof originalReadFileSync>[1]);
  }) as typeof fs.readFileSync;
  return () => {
    fs.readFileSync = originalReadFileSync;
    fs.existsSync = originalExistsSync;
  };
}

export interface RecordedFetch {
  url: URL;
  method: string;
  headers: Record<string, string>;
  /** Parsed JSON request body, or undefined for bodiless requests. */
  body: unknown;
}

export interface FetchStub {
  calls: RecordedFetch[];
  restore: () => void;
}

/**
 * Replace globalThis.fetch with `respond`, recording every request so a test
 * can assert on what was sent. Register `stub.restore` with `t.after(...)`.
 */
export function stubFetch(
  respond: (call: RecordedFetch) => Response | Promise<Response>,
): FetchStub {
  const original = globalThis.fetch;
  const calls: RecordedFetch[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: RecordedFetch = {
      url: new URL(input instanceof Request ? input.url : String(input)),
      method: init?.method ?? "GET",
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
