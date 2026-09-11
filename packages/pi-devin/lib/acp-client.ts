/**
 * DevinAcpClient — owns the `devin acp` child process and the ACP
 * JSON-RPC connection over stdio, via @agentclientprotocol/sdk.
 *
 * One client hosts many ACP sessions; session/update notifications are
 * routed to per-session listeners registered by the runtime. During
 * `session/load` devin replays the whole transcript as updates, so loads
 * buffer and drop replayed content kinds while still forwarding state
 * updates (usage, config, mode, title) that arrive with the replay tail.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export type DevinSessionUpdate = acp.SessionUpdate;
export type DevinContentBlock = acp.ContentBlock;
export type DevinSessionListener = (update: DevinSessionUpdate) => void;

export interface DevinPromptResult {
  stopReason?: string;
  usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number };
  meta?: Record<string, unknown>;
}

export interface DevinNewSessionResult {
  sessionId: string;
  modes?: { currentModeId?: string; availableModes?: { id: string; name: string }[] };
  configOptions?: DevinConfigOption[];
}

export interface DevinConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: { value: string; name: string; description?: string }[];
}

export interface DevinListSessionInfo {
  sessionId: string;
  cwd?: string;
  title?: string;
  updatedAt?: string;
  meta?: Record<string, unknown>;
}

export interface DevinRequestPermissionParams {
  sessionId: string;
  toolCall: { toolCallId?: string; title?: string; kind?: string; rawInput?: unknown };
  options: { optionId: string; name?: string; kind?: string }[];
}

export type DevinPermissionHandler = (
  params: DevinRequestPermissionParams,
) => Promise<acp.RequestPermissionResponse>;

export type DevinCustomNotificationHandler = (method: string, params: unknown) => void;

export interface DevinClientStats {
  pid?: number;
  spawned: number;
  requestsSent: number;
  notificationsReceived: number;
}

export interface DevinAcpClientOptions {
  binary: string;
  /** Extra argv after `acp` (e.g. --model). */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  clientInfo?: { name: string; version: string };
  onLog?: (line: string) => void;
  /** Test seam — replace process spawn. */
  spawnProcess?: (binary: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
}

const LOG_LIMIT = 64 * 1024;

export class DevinAcpClient {
  #options: DevinAcpClientOptions;
  #child: ChildProcess | undefined;
  #connection: acp.ClientConnection | undefined;
  #agent: acp.ClientContext | undefined;
  #startPromise: Promise<void> | undefined;
  #sessionListeners = new Map<string, DevinSessionListener>();
  #loadingBuffers = new Map<string, acp.SessionUpdate[]>();
  #permissionHandler: DevinPermissionHandler | undefined;
  #customHandler: DevinCustomNotificationHandler | undefined;
  #closed = false;
  #stats = { spawned: 0, requestsSent: 0, notificationsReceived: 0 };
  #stderrTail = "";
  #onClose: (() => void) | undefined;

  constructor(options: DevinAcpClientOptions) {
    this.#options = options;
  }

  setPermissionHandler(handler: DevinPermissionHandler | undefined): void {
    this.#permissionHandler = handler;
  }

  setCustomNotificationHandler(handler: DevinCustomNotificationHandler | undefined): void {
    this.#customHandler = handler;
  }

  setSessionListener(sessionId: string, listener: DevinSessionListener | undefined): void {
    if (listener) this.#sessionListeners.set(sessionId, listener);
    else this.#sessionListeners.delete(sessionId);
  }

  setOnClose(handler: (() => void) | undefined): void {
    this.#onClose = handler;
  }

  get stats(): DevinClientStats {
    return { pid: this.#child?.pid, ...this.#stats };
  }

  get stderrTail(): string {
    return this.#stderrTail;
  }

  /** Spawn the child and perform the ACP initialize handshake exactly once. */
  ensureStarted(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("devin ACP client is closed."));
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#start().catch((error) => {
      this.#startPromise = undefined;
      throw error;
    });
    return this.#startPromise;
  }

  async #start(): Promise<void> {
    const spawnImpl =
      this.#options.spawnProcess ??
      ((binary: string, args: string[], env: NodeJS.ProcessEnv) =>
        spawn(binary, args, { env, stdio: ["pipe", "pipe", "pipe"] }));
    const child = spawnImpl(this.#options.binary, ["acp", ...(this.#options.args ?? [])], {
      ...process.env,
      ...this.#options.env,
    });
    this.#child = child;
    this.#stats.spawned += 1;

    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      this.#stderrTail = (this.#stderrTail + text).slice(-LOG_LIMIT);
      for (const line of text.split("\n")) {
        if (line.trim()) this.#options.onLog?.(line);
      }
    });
    child.on("exit", () => this.#onClose?.());
    // Spawn failures (ENOENT/EACCES on the resolved binary) emit "error"
    // without "exit"; surface them through the same close path so the
    // runtime recovers deterministically instead of relying on stdio
    // teardown.
    child.on("error", (error) => {
      this.#options.onLog?.(`child error: ${error.message}`);
      this.#onClose?.();
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    );

    const passthrough = (params: unknown) => params;
    const app = acp
      .client(this.#options.clientInfo ?? { name: "pi-devin" })
      .onRequest(
        acp.methods.client.session.requestPermission,
        async (ctx): Promise<acp.RequestPermissionResponse> => {
          const params = ctx.params as unknown as DevinRequestPermissionParams;
          if (!this.#permissionHandler) return { outcome: { outcome: "cancelled" } };
          return this.#permissionHandler(params);
        },
      )
      .onNotification(acp.methods.client.session.update, (ctx) => {
        this.#stats.notificationsReceived += 1;
        this.#dispatchSessionUpdate(ctx.params.sessionId, ctx.params.update);
      });
    // Cognition extension notifications; also lets tests see raw traffic.
    for (const method of [
      "_cognition.ai/agent_stopped",
      "_cognition.ai/turn_stats",
      "_cognition.ai/thinking_complete",
      "_cognition.ai/output",
      "_cognition.ai/mcp/serversChanged",
    ]) {
      app.onNotification(method, passthrough, (ctx) => {
        this.#stats.notificationsReceived += 1;
        this.#customHandler?.(method, ctx.params);
      });
    }

    this.#connection = app.connect(stream);
    this.#agent = this.#connection.agent;
    this.#connection.closed.then(() => this.#onClose?.());
    await this.#agent.request(acp.methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: this.#options.clientInfo ?? { name: "pi-devin", version: "0.0.0" },
    });
  }

  #dispatchSessionUpdate(sessionId: string, update: acp.SessionUpdate): void {
    const buffer = this.#loadingBuffers.get(sessionId);
    if (buffer) {
      buffer.push(update);
      return;
    }
    this.#sessionListeners.get(sessionId)?.(update);
  }

  async newSession(cwd: string): Promise<DevinNewSessionResult> {
    await this.ensureStarted();
    this.#stats.requestsSent += 1;
    const result = (await this.#agent!.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: [],
    })) as DevinNewSessionResult;
    return result;
  }

  /**
   * Load a persisted session. History replays as session/update notifications
   * before the response resolves; replayed content kinds are dropped and
   * trailing state updates are forwarded to the registered listener.
   */
  async loadSession(acpSessionId: string, cwd: string): Promise<DevinNewSessionResult> {
    await this.ensureStarted();
    this.#stats.requestsSent += 1;
    this.#loadingBuffers.set(acpSessionId, []);
    try {
      const result = (await this.#agent!.request(acp.methods.agent.session.load, {
        sessionId: acpSessionId,
        cwd,
        mcpServers: [],
      })) as DevinNewSessionResult;
      const buffered = this.#loadingBuffers.get(acpSessionId) ?? [];
      const listener = this.#sessionListeners.get(acpSessionId);
      if (listener) {
        for (const update of buffered) {
          if (isReplayedContentUpdate(update)) continue;
          listener(update);
        }
      }
      return result;
    } finally {
      this.#loadingBuffers.delete(acpSessionId);
    }
  }

  async prompt(sessionId: string, prompt: DevinContentBlock[]): Promise<DevinPromptResult> {
    await this.ensureStarted();
    this.#stats.requestsSent += 1;
    const result = (await this.#agent!.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt,
    })) as acp.PromptResponse;
    return {
      stopReason: result.stopReason,
      usage: result.usage as DevinPromptResult["usage"],
      meta: result._meta ?? undefined,
    };
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.#agent) return;
    await this.#agent.notify(acp.methods.agent.session.cancel, { sessionId });
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.ensureStarted();
    this.#stats.requestsSent += 1;
    await this.#agent!.request(acp.methods.agent.session.setMode, { sessionId, modeId });
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<DevinConfigOption[]> {
    await this.ensureStarted();
    this.#stats.requestsSent += 1;
    const result = (await this.#agent!.request(acp.methods.agent.session.setConfigOption, {
      sessionId,
      configId,
      value,
    })) as { configOptions?: DevinConfigOption[] };
    return result.configOptions ?? [];
  }

  async listSessions(): Promise<DevinListSessionInfo[]> {
    await this.ensureStarted();
    this.#stats.requestsSent += 1;
    const result = (await this.#agent!.request(acp.methods.agent.session.list, {})) as {
      sessions?: Array<{
        sessionId: string;
        cwd?: string;
        title?: string;
        updatedAt?: string;
        _meta?: Record<string, unknown>;
      }>;
    };
    return (result.sessions ?? []).map((session) => ({
      sessionId: session.sessionId,
      cwd: session.cwd,
      title: session.title,
      updatedAt: session.updatedAt,
      meta: session._meta ?? undefined,
    }));
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.ensureStarted();
    this.#stats.requestsSent += 1;
    await this.#agent!.request(acp.methods.agent.session.delete, { sessionId });
  }

  async authenticate(methodId: string): Promise<void> {
    await this.ensureStarted();
    this.#stats.requestsSent += 1;
    await this.#agent!.request(acp.methods.agent.authenticate, { methodId });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#sessionListeners.clear();
    try {
      this.#connection?.close();
    } catch {
      // best-effort
    }
    const child = this.#child;
    this.#child = undefined;
    if (child && child.exitCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      setTimeout(() => {
        try {
          if (child.exitCode === null) child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, 2_000).unref?.();
    }
  }
}

/** Update kinds that replay transcript content during session/load. */
function isReplayedContentUpdate(update: acp.SessionUpdate): boolean {
  return (
    update.sessionUpdate === "user_message_chunk" ||
    update.sessionUpdate === "agent_message_chunk" ||
    update.sessionUpdate === "agent_thought_chunk" ||
    update.sessionUpdate === "tool_call" ||
    update.sessionUpdate === "tool_call_update" ||
    update.sessionUpdate === "plan" ||
    update.sessionUpdate === "plan_update" ||
    update.sessionUpdate === "plan_removed"
  );
}
