export const PROTOCOL_VERSION = 1;

export interface BridgeRegistryFile {
  pid: number;
  socketPath: string;
  workspaceFolders: string[];
  startedAt: number;
}

export interface HelloMessage {
  type: "hello";
  protocol: number;
  sessionId: string;
  piCwd: string;
  sessionFile: string | null;
  name: string | null;
  pid: number;
}
export interface ByeMessage {
  type: "bye";
  reason: "shutdown" | "disconnect";
}
export type ClientMessage = HelloMessage | ByeMessage;

export interface WelcomeMessage {
  type: "welcome";
  protocol: number;
  workspaceFolders: string[];
}
export interface RejectMessage {
  type: "reject";
  reason: string;
}
export interface PrefillMessage {
  type: "prefill";
  text: string;
}
export interface DetachedMessage {
  type: "detached";
  reason: "superseded" | "server-shutdown";
}
export type ServerMessage = WelcomeMessage | RejectMessage | PrefillMessage | DetachedMessage;

/** Serialize one message as a single JSONL record, including the trailing newline. */
export function encodeFrame(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Stateful JSONL splitter. Feed it arbitrary chunks; it returns the complete
 * lines contained in what it has seen so far.
 *
 * Rules:
 *  - split on "\n" only
 *  - strip one trailing "\r" from each line if present
 *  - skip lines that are empty after stripping
 *  - buffer any incomplete trailing line for the next call
 */
export function createFrameSplitter(): (chunk: string) => string[] {
  let buffer = "";
  return (chunk: string): string[] => {
    buffer += chunk;
    const lines: string[] = [];
    for (;;) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (line.length > 0) {
        lines.push(line);
      }
    }
    return lines;
  };
}

/** `formatRef("a.ts")` -> "a.ts"; `("a.ts",42,42)` -> "a.ts:42"; `("a.ts",12,40)` -> "a.ts:12-40" */
export function formatRef(relPath: string, startLine?: number, endLine?: number): string {
  if (startLine === undefined) return relPath;
  const end = endLine ?? startLine;
  if (startLine === end) {
    return `${relPath}:${startLine}`;
  }
  return `${relPath}:${startLine}-${end}`;
}

/** Join refs with a single space and append one trailing space. */
export function joinRefs(refs: string[]): string {
  return `${refs.join(" ")} `;
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function normalizeSegments(path: string, windowsStyle: boolean): string[] {
  const parts = path
    .split(windowsStyle ? /[\\/]+/ : /\/+/)
    .filter((part) => part !== "" && part !== ".");
  const segments: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      if (segments.length > 0) segments.pop();
    } else {
      segments.push(windowsStyle ? part.toLowerCase() : part);
    }
  }
  return segments;
}

/**
 * True when `child` is the same path as `parent` or lives underneath it.
 * Must NOT be fooled by a shared string prefix: "/a/bc" is NOT inside "/a/b".
 * Implement by comparing normalized segment arrays, not with startsWith on strings.
 * Do not import node:path because this file is also compiled into the VS Code host.
 * Windows drive and UNC paths compare case-insensitively.
 */
export function isPathInside(parent: string, child: string): boolean {
  if (typeof parent !== "string" || typeof child !== "string") return false;
  const windowsStyle = isWindowsAbsolutePath(parent) || isWindowsAbsolutePath(child);
  const parentSegs = normalizeSegments(parent, windowsStyle);
  const childSegs = normalizeSegments(child, windowsStyle);
  if (childSegs.length < parentSegs.length) return false;
  for (let i = 0; i < parentSegs.length; i++) {
    if (parentSegs[i] !== childSegs[i]) return false;
  }
  return true;
}
