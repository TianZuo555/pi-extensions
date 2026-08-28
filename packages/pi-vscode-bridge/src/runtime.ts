/**
 * BridgeClient — Effect v4-owned unix-socket client for the VS Code bridge.
 */

import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  FiberSet,
  Layer,
  ManagedRuntime,
  MutableRef,
  Result,
} from "effect";
import {
  type BridgeRegistryFile,
  createFrameSplitter,
  encodeFrame,
  isPathInside,
  type HelloMessage,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "../lib/protocol.ts";

function bridgeDir(): string {
  return join(getAgentDir(), "vscode-bridge");
}

export class BridgeNoServerError extends Data.TaggedError("BridgeNoServerError")<{
  readonly message: string;
}> {}

export class BridgeRejectedError extends Data.TaggedError("BridgeRejectedError")<{
  readonly reason: string;
}> {}

export class BridgeIoError extends Data.TaggedError("BridgeIoError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

export interface BridgeCallbacks {
  readonly onPrefill: (text: string) => void;
  readonly onDetached: (reason: "superseded" | "server-shutdown") => void;
  readonly onLost: () => void;
  readonly onReattached: () => void;
}

export interface BridgeHello {
  readonly sessionId: string;
  readonly piCwd: string;
  readonly sessionFile: string | null;
  readonly name: string | null;
}

export interface BridgeServerInfo {
  readonly pid: number;
  readonly socketPath: string;
  readonly workspaceFolders: string[];
  readonly startedAt: number;
}

export interface BridgeAttachment {
  readonly socketPath: string;
  readonly serverPid: number;
  readonly workspaceFolders: string[];
}

export interface BridgeClientShape {
  readonly discover: (piCwd: string) => Effect.Effect<BridgeServerInfo[], never>;
  readonly connect: (
    server: BridgeServerInfo,
    hello: BridgeHello,
    callbacks: BridgeCallbacks,
  ) => Effect.Effect<BridgeAttachment, BridgeRejectedError | BridgeIoError>;
  readonly disconnect: (reason: "shutdown" | "disconnect") => Effect.Effect<void, never>;
  readonly current: Effect.Effect<BridgeAttachment | undefined, never>;
}

export class BridgeClient extends Context.Service<BridgeClient, BridgeClientShape>()(
  "pi-vscode-bridge/BridgeClient",
) {}

export interface BridgeClientTestControls {
  readonly retryDelaysMs?: number[];
}

export interface BridgeClientOptions {
  readonly testControls?: BridgeClientTestControls;
}

const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

function ioError(operation: string, cause: unknown): BridgeIoError {
  return new BridgeIoError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function foldersRelateToCwd(folders: string[], piCwd: string): boolean {
  for (const folder of folders) {
    if (isPathInside(folder, piCwd) || isPathInside(piCwd, folder)) {
      return true;
    }
  }
  return false;
}

function parseRegistry(raw: string): BridgeRegistryFile | undefined {
  try {
    const parsed = JSON.parse(raw) as BridgeRegistryFile;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.socketPath === "string" &&
      Array.isArray(parsed.workspaceFolders) &&
      typeof parsed.startedAt === "number"
    ) {
      return parsed;
    }
  } catch {
    // ignore malformed registry files
  }
  return undefined;
}

function parseServerMessage(line: string): ServerMessage | undefined {
  try {
    return JSON.parse(line) as ServerMessage;
  } catch {
    return undefined;
  }
}

const makeBridgeClient = (retryDelaysMs: number[]) =>
  Effect.gen(function* () {
    const retryFibers = yield* FiberSet.make<void>();
    const runRetry = yield* FiberSet.runtime(retryFibers)();

    const socketRef = MutableRef.make<Socket | undefined>(undefined);
    const attachmentRef = MutableRef.make<BridgeAttachment | undefined>(undefined);
    const suppressRetryRef = MutableRef.make(false);
    const generationRef = MutableRef.make(0);
    const retryTokenRef = MutableRef.make(0);
    const helloRef = MutableRef.make<BridgeHello | undefined>(undefined);
    const callbacksRef = MutableRef.make<BridgeCallbacks | undefined>(undefined);

    const destroySocket = (socket: Socket | undefined) => {
      if (!socket) return;
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.destroy();
      }
    };

    const discover: BridgeClientShape["discover"] = (piCwd) =>
      Effect.promise(async () => {
        const dir = bridgeDir();
        const { readdir, readFile } = await import("node:fs/promises");
        const { existsSync } = await import("node:fs");
        if (!existsSync(dir)) return [];

        const entries = await readdir(dir).catch(() => [] as string[]);
        const servers: BridgeServerInfo[] = [];
        for (const entry of entries) {
          if (!entry.endsWith(".json")) continue;
          const raw = await readFile(join(dir, entry), "utf8").catch(() => null);
          if (!raw) continue;
          const registry = parseRegistry(raw);
          if (!registry) continue;
          if (!registry.socketPath || !existsSync(registry.socketPath)) continue;
          if (!foldersRelateToCwd(registry.workspaceFolders, piCwd)) continue;
          servers.push({
            pid: registry.pid,
            socketPath: registry.socketPath,
            workspaceFolders: registry.workspaceFolders,
            startedAt: registry.startedAt,
          });
        }
        servers.sort((a, b) => b.startedAt - a.startedAt);
        return servers;
      });

    const connectOnce = (
      server: BridgeServerInfo,
      hello: BridgeHello,
      callbacks: BridgeCallbacks,
    ): Effect.Effect<BridgeAttachment, BridgeRejectedError | BridgeIoError> =>
      Effect.callback<BridgeAttachment, BridgeRejectedError | BridgeIoError>((resume) => {
        MutableRef.set(suppressRetryRef, false);
        MutableRef.set(helloRef, hello);
        MutableRef.set(callbacksRef, callbacks);

        const previous = MutableRef.get(socketRef);
        destroySocket(previous);

        const gen = MutableRef.get(generationRef) + 1;
        MutableRef.set(generationRef, gen);

        let settled = false;
        let handshakeDone = false;
        const split = createFrameSplitter();

        const finish = (
          effect: Effect.Effect<BridgeAttachment, BridgeRejectedError | BridgeIoError>,
        ) => {
          if (settled) return;
          settled = true;
          resume(effect);
        };

        const socket = createConnection({ path: server.socketPath });
        MutableRef.set(socketRef, socket);
        socket.setEncoding("utf8");

        socket.on("connect", () => {
          if (MutableRef.get(generationRef) !== gen) return;
          const payload: HelloMessage = {
            type: "hello",
            protocol: PROTOCOL_VERSION,
            sessionId: hello.sessionId,
            piCwd: hello.piCwd,
            sessionFile: hello.sessionFile,
            name: hello.name,
            pid: process.pid,
          };
          socket.write(encodeFrame(payload));
        });

        socket.on("data", (chunk: string) => {
          if (MutableRef.get(generationRef) !== gen) return;
          for (const line of split(chunk)) {
            const message = parseServerMessage(line);
            if (!message || typeof message.type !== "string") continue;

            if (!handshakeDone) {
              if (message.type === "welcome") {
                handshakeDone = true;
                const attachment: BridgeAttachment = {
                  socketPath: server.socketPath,
                  serverPid: server.pid,
                  workspaceFolders: server.workspaceFolders,
                };
                MutableRef.set(attachmentRef, attachment);
                finish(Effect.succeed(attachment));
                continue;
              }
              if (message.type === "reject") {
                MutableRef.set(suppressRetryRef, true);
                destroySocket(socket);
                finish(
                  Effect.fail(
                    new BridgeRejectedError({
                      reason: message.reason,
                    }),
                  ),
                );
                return;
              }
              continue;
            }

            if (message.type === "prefill") {
              callbacks.onPrefill(message.text);
            } else if (message.type === "detached") {
              MutableRef.set(suppressRetryRef, true);
              MutableRef.set(attachmentRef, undefined);
              callbacks.onDetached(message.reason);
            }
          }
        });

        socket.on("error", (error) => {
          if (settled) return;
          destroySocket(socket);
          finish(Effect.fail(ioError("connect", error)));
        });

        socket.on("close", () => {
          if (MutableRef.get(generationRef) !== gen) return;
          if (MutableRef.get(socketRef) === socket) {
            MutableRef.set(socketRef, undefined);
          }
          if (!settled) {
            finish(Effect.fail(ioError("connect", new Error("socket closed before welcome"))));
            return;
          }
          if (MutableRef.get(suppressRetryRef)) return;
          MutableRef.set(attachmentRef, undefined);
          startRetryLoop();
        });
      });

    const startRetryLoop = () => {
      const callbacks = MutableRef.get(callbacksRef);
      const hello = MutableRef.get(helloRef);
      if (!callbacks || !hello) return;

      const token = MutableRef.get(retryTokenRef);
      const stale = () => MutableRef.get(retryTokenRef) !== token;

      runRetry(
        Effect.gen(function* () {
          for (const delayMs of retryDelaysMs) {
            if (stale()) return;
            yield* Effect.sleep(delayMs);
            if (stale()) return;

            const servers = yield* discover(hello.piCwd);
            if (servers.length === 0) continue;

            const result = yield* Effect.result(connectOnce(servers[0]!, hello, callbacks));
            if (Result.isSuccess(result)) {
              callbacks.onReattached();
              return;
            }
            if (stale()) return;
          }
          if (stale()) return;
          MutableRef.set(attachmentRef, undefined);
          callbacks.onLost();
        }),
      );
    };

    const connect: BridgeClientShape["connect"] = (server, hello, callbacks) =>
      Effect.gen(function* () {
        MutableRef.set(retryTokenRef, MutableRef.get(retryTokenRef) + 1);
        return yield* connectOnce(server, hello, callbacks);
      });

    const disconnect: BridgeClientShape["disconnect"] = (reason) =>
      Effect.gen(function* () {
        MutableRef.set(suppressRetryRef, true);
        MutableRef.set(retryTokenRef, MutableRef.get(retryTokenRef) + 1);

        const socket = MutableRef.get(socketRef);
        if (socket && !socket.destroyed) {
          try {
            socket.end(encodeFrame({ type: "bye", reason }));
          } catch {
            socket.destroy();
          }
          const timer = setTimeout(() => socket.destroy(), 1000);
          timer.unref();
          socket.once("close", () => clearTimeout(timer));
        }
        MutableRef.set(socketRef, undefined);
        MutableRef.set(attachmentRef, undefined);
        MutableRef.set(generationRef, MutableRef.get(generationRef) + 1);
      });

    const current: BridgeClientShape["current"] = Effect.sync(() => MutableRef.get(attachmentRef));

    return BridgeClient.of({
      discover,
      connect,
      disconnect,
      current,
    });
  });

export const BridgeClientLive: Layer.Layer<BridgeClient> = Layer.effect(
  BridgeClient,
  makeBridgeClient(DEFAULT_RETRY_DELAYS_MS),
);

export function createBridgeClient(options?: BridgeClientOptions) {
  const retryDelaysMs = options?.testControls?.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  return ManagedRuntime.make(Layer.effect(BridgeClient, makeBridgeClient(retryDelaysMs)));
}

export type BridgeClientInstance = ReturnType<typeof createBridgeClient>;

export async function runBridge<A, E>(
  runtime: BridgeClientInstance,
  effect: Effect.Effect<A, E>,
  options: { signal?: AbortSignal } = {},
): Promise<A> {
  const exit = await runtime.runPromiseExit(
    effect,
    options.signal ? { signal: options.signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    const error = new Error("Bridge operation was aborted");
    error.name = "AbortError";
    throw error;
  }
  const failure = Cause.findFail(exit.cause);
  if (Result.isSuccess(failure)) throw failure.success.error;
  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
}
