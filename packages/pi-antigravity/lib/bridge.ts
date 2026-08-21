/**
 * AgyPiBridge — loopback MCP server (streamable HTTP) exposing active pi
 * tools to agy as `pi__<name>`, plus the pending-call store that correlates
 * agy's MCP calls with pi tool executions.
 *
 * Call flow (mirrors the replay flow, but executing):
 *   1. agy calls `pi__<tool>` → our HTTP handler enqueues a pending call and
 *      notifies the runtime (`onCall`), which pushes a synthetic
 *      `bridge_call` activity into the live AgyTurnController;
 *   2. the provider ends the pi turn with stopReason "toolUse" for the REAL
 *      pi tool (native cards, hooks, permissions, abort);
 *   3. pi executes the tool; the toolResult lands in context;
 *   4. the next streamAntigravity request re-attaches to the running agy
 *      turn, matches the toolResult by toolCallId, resolves the HTTP
 *      response, and agy continues in the same conversation.
 *
 * The handler never resolves directly from the HTTP side: it blocks until
 * the provider hands back the executed result, or times out (fail closed).
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const BRIDGE_SERVER_NAME = "pi-bridge";
export const BRIDGE_TOOL_PREFIX = "pi__";

/** Per-call cap; must stay below agy's 600s turn timeout so agy can still report the failure. */
export const BRIDGE_CALL_TIMEOUT_MS = 480_000;

export interface BridgeToolDef {
  /** Real pi tool name (without the `pi__` prefix). */
  name: string;
  description: string;
  /** JSON schema (typebox) for the tool parameters. */
  parameters: unknown;
}

export interface BridgeCallResult {
  content: string;
  isError: boolean;
}

export interface BridgeCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

type PendingCall = BridgeCall & {
  resolve: (result: BridgeCallResult) => void;
  timer: NodeJS.Timeout;
};

/**
 * A bridge-virtual tool: handled entirely inside the extension without a
 * pi toolUse round-trip (used for `activate_skill` — a local file read
 * needs no hooks, permissions, or rendering).
 */
interface VirtualTool {
  description: string;
  parameters: unknown;
  handler: (args: Record<string, unknown>) => Promise<BridgeCallResult>;
}

interface JsonRpcRequest {
  id?: number | string | null;
  method?: string;
  params?: {
    protocolVersion?: string;
    name?: string;
    arguments?: Record<string, unknown>;
  };
}

export class AgyPiBridge {
  #tools: BridgeToolDef[] = [];
  #server: Server | undefined;
  #port = 0;
  #seq = 0;
  #pending = new Map<string, PendingCall>();
  /** Callback that routes a call into the live agy turn controller. Returns false when no turn is active. */
  #onCall: ((call: BridgeCall) => boolean) | undefined;
  /** Source of the current active-tool snapshot, invoked once per provider request. */
  #toolSource: (() => BridgeToolDef[]) | undefined;
  #virtual = new Map<string, VirtualTool>();

  setOnCall(onCall: (call: BridgeCall) => boolean): void {
    this.#onCall = onCall;
  }

  setToolSource(toolSource: () => BridgeToolDef[]): void {
    this.#toolSource = toolSource;
  }

  /** Refresh the exposed-tool snapshot from the configured source. */
  refreshTools(): void {
    this.#tools = this.#toolSource?.() ?? [];
  }

  /**
   * Register a bridge-virtual tool. Virtual tools are always listed and are
   * handled in-process instead of being routed into the agy turn.
   */
  registerVirtualTool(
    name: string,
    definition: { description: string; parameters: unknown },
    handler: (args: Record<string, unknown>) => Promise<BridgeCallResult>,
  ): void {
    this.#virtual.set(name, { ...definition, handler });
  }

  get url(): string | undefined {
    return this.#server ? `http://127.0.0.1:${this.#port}/mcp` : undefined;
  }

  get running(): boolean {
    return this.#server !== undefined;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  start(): Promise<void> {
    if (this.#server) return Promise.resolve();
    const server = createServer((req, res) => this.#handleHttp(req, res));
    this.#server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") this.#port = addr.port;
        resolve();
      });
    });
  }

  /** Fail all pending calls and stop listening. */
  close(): Promise<void> {
    const server = this.#server;
    if (!server) return Promise.resolve();
    this.#server = undefined;
    this.#port = 0;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({
        content: "antigravity: pi session shut down while the tool call was pending.",
        isError: true,
      });
    }
    this.#pending.clear();
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  /** True when the provider is still waiting for pi to execute this call. */
  isAwaiting(callId: string): boolean {
    return this.#pending.has(callId);
  }

  /** Hand the executed pi tool result back to the waiting agy MCP call. */
  resolveCall(callId: string, result: BridgeCallResult): boolean {
    const pending = this.#pending.get(callId);
    if (!pending) return false;
    this.#pending.delete(callId);
    clearTimeout(pending.timer);
    pending.resolve(result);
    return true;
  }

  // --- HTTP / JSON-RPC -----------------------------------------------------

  #handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "GET not supported" } }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let rpc: JsonRpcRequest;
      try {
        rpc = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as JsonRpcRequest;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }));
        return;
      }
      void this.#handleRpc(rpc).then(
        (response) => {
          if (!response) {
            // Notification: no body per the streamable HTTP spec.
            res.writeHead(202);
            res.end();
            return;
          }
          res.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": SESSION_ID,
          });
          res.end(JSON.stringify(response));
        },
        () => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" } }));
        },
      );
    });
  }

  async #handleRpc(rpc: JsonRpcRequest): Promise<Record<string, unknown> | undefined> {
    const base = { jsonrpc: "2.0", id: rpc.id ?? null };
    switch (rpc.method) {
      case "initialize": {
        return {
          ...base,
          result: {
            protocolVersion: rpc.params?.protocolVersion ?? "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: BRIDGE_SERVER_NAME, version: "1.0.0" },
          },
        };
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return undefined; // notification — 202, no body
      case "tools/list": {
        return {
          ...base,
          result: {
            tools: [
              ...this.#tools.map((tool) => ({
                name: `${BRIDGE_TOOL_PREFIX}${tool.name}`,
                description:
                  tool.description ||
                  `pi tool "${tool.name}" bridged into agy by ${BRIDGE_SERVER_NAME}.`,
                inputSchema: tool.parameters,
              })),
              ...[...this.#virtual].map(([name, definition]) => ({
                name: `${BRIDGE_TOOL_PREFIX}${name}`,
                description: definition.description,
                inputSchema: definition.parameters,
              })),
            ],
          },
        };
      }
      case "tools/call": {
        const name = rpc.params?.name ?? "";
        const args = rpc.params?.arguments ?? {};
        const result = await this.#routeCall(name, args);
        return {
          ...base,
          result: {
            content: [{ type: "text", text: result.content }],
            isError: result.isError,
          },
        };
      }
      default:
        return {
          ...base,
          error: { code: -32601, message: `Method not found: ${rpc.method}` },
        };
    }
  }

  /**
   * Route one `pi__<tool>` invocation into the live agy turn and wait for pi
   * to execute it. Fails closed: no active turn, unknown tool, or timeout
   * all produce an isError result rather than hanging agy.
   */
  async #routeCall(mcpName: string, args: Record<string, unknown>): Promise<BridgeCallResult> {
    if (!mcpName.startsWith(BRIDGE_TOOL_PREFIX)) {
      return { content: `antigravity: unknown tool "${mcpName}" — only pi__* bridge tools exist.`, isError: true };
    }
    const tool = mcpName.slice(BRIDGE_TOOL_PREFIX.length);
    const virtual = this.#virtual.get(tool);
    if (virtual) return virtual.handler(args);
    if (!this.#tools.some((def) => def.name === tool)) {
      return { content: `antigravity: tool "${tool}" is not currently active in pi.`, isError: true };
    }
    const id = `pi-bridge-${++this.#seq}`;
    const dispatched = this.#onCall?.({ id, tool, args }) ?? false;
    if (!dispatched) {
      return { content: "antigravity: no active agy turn to route the tool call into.", isError: true };
    }
    return new Promise<BridgeCallResult>((resolve) => {
      const pending: PendingCall = {
        id,
        tool,
        args,
        resolve,
        timer: setTimeout(() => {
          this.#pending.delete(id);
          resolve({
            content: `antigravity: pi tool "${tool}" did not return within ${Math.round(BRIDGE_CALL_TIMEOUT_MS / 1000)}s.`,
            isError: true,
          });
        }, BRIDGE_CALL_TIMEOUT_MS),
      };
      this.#pending.set(id, pending);
    });
  }
}

const SESSION_ID = randomUUID();

/** Extract bridge-awaiting tool results from a pi context and resolve them. */
export function resolveBridgeResultsFromContext(
  bridge: AgyPiBridge,
  messages: readonly unknown[],
): number {
  let resolved = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as {
      role?: string;
      toolCallId?: string;
      isError?: boolean;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (message?.role !== "toolResult" || !message.toolCallId) continue;
    if (!bridge.isAwaiting(message.toolCallId)) continue;
    const text = (message.content ?? [])
      .filter((part) => part?.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    bridge.resolveCall(message.toolCallId, { content: text, isError: message.isError === true });
    resolved += 1;
  }
  return resolved;
}
