import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  createFrameSplitter,
  encodeFrame,
  formatRef,
  isPathInside,
  joinRefs,
  PROTOCOL_VERSION,
  type HelloMessage,
} from "./protocol";
import { findHunkForNewLine, hunkNewRange, parseHunks } from "./hunks";

interface AttachedClient {
  socket: net.Socket;
  hello: HelloMessage;
}

let server: net.Server | undefined;
let attached: AttachedClient | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let socketPath: string | undefined;
let registryPath: string | undefined;
let startedAt = 0;

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

function bridgeDir(): string {
  return path.join(agentDir(), "vscode-bridge");
}

function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

function writeRegistry(): void {
  if (!registryPath || !socketPath) return;
  const payload = {
    pid: process.pid,
    socketPath,
    workspaceFolders: workspaceFolders(),
    startedAt,
  };
  fs.writeFileSync(registryPath, JSON.stringify(payload), "utf8");
}

function parseClientMessage(line: string): { type: string } | undefined {
  try {
    return JSON.parse(line) as { type: string };
  } catch {
    return undefined;
  }
}

function endWithFrame(socket: net.Socket, message: unknown): void {
  try {
    socket.end(encodeFrame(message));
  } catch {
    socket.destroy();
    return;
  }
  const timer = setTimeout(() => socket.destroy(), 1000);
  timer.unref();
  socket.once("close", () => clearTimeout(timer));
}

function parseHello(message: { type: string }): HelloMessage | undefined {
  const candidate = message as Partial<HelloMessage>;
  if (typeof candidate.protocol !== "number") return undefined;
  if (typeof candidate.sessionId !== "string") return undefined;
  if (typeof candidate.piCwd !== "string" || candidate.piCwd.length === 0) return undefined;
  if (typeof candidate.pid !== "number") return undefined;
  if (candidate.sessionFile !== null && typeof candidate.sessionFile !== "string") return undefined;
  if (candidate.name !== null && typeof candidate.name !== "string") return undefined;
  return candidate as HelloMessage;
}

function rejectSocket(socket: net.Socket, reason: string): void {
  endWithFrame(socket, { type: "reject", reason });
}

function foldersAcceptCwd(piCwd: string): boolean {
  for (const folder of workspaceFolders()) {
    if (isPathInside(folder, piCwd) || isPathInside(piCwd, folder)) {
      return true;
    }
  }
  return false;
}

function evictAttached(reason: "superseded" | "server-shutdown"): void {
  if (!attached) return;
  const socket = attached.socket;
  attached = undefined;
  updateStatusBar();
  endWithFrame(socket, { type: "detached", reason });
}

function updateStatusBar(): void {
  if (!statusBar) return;
  if (!attached) {
    statusBar.hide();
    return;
  }
  statusBar.text = `$(plug) pi: ${path.basename(attached.hello.piCwd)}`;
  statusBar.tooltip = `${attached.hello.piCwd}\n${attached.hello.sessionFile ?? "(no session file)"}`;
  statusBar.show();
}

function normalizeUri(uri: vscode.Uri): vscode.Uri {
  return uri.scheme === "git" ? uri.with({ scheme: "file", query: "", fragment: "" }) : uri;
}

function relRefForUri(uri: vscode.Uri): string {
  if (!attached) return uri.fsPath;
  const rel = path.relative(attached.hello.piCwd, uri.fsPath);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return uri.fsPath;
  }
  return rel;
}

async function sendRefs(refs: string[]): Promise<void> {
  if (refs.length === 0) return;
  if (!attached) {
    const choice = await vscode.window.showWarningMessage(
      "No Pi agent is attached.",
      "Copy /vscode-connect",
    );
    if (choice === "Copy /vscode-connect") {
      await vscode.env.clipboard.writeText("/vscode-connect");
    }
    return;
  }
  try {
    attached.socket.write(encodeFrame({ type: "prefill", text: joinRefs(refs) }));
  } catch {
    attached = undefined;
    updateStatusBar();
    void vscode.window.showWarningMessage("Lost the connection to Pi. Run /vscode-connect again.");
  }
}

async function sendFromExplorer(uri: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
  const resources = (uris && uris.length > 0 ? uris : uri ? [uri] : []).filter(Boolean);
  if (resources.length === 0) return;
  const refs: string[] = [];
  for (const resource of resources) {
    if (resource.scheme !== "file") continue;
    let rel = relRefForUri(resource);
    try {
      const stat = fs.statSync(resource.fsPath);
      if (stat.isDirectory()) {
        if (rel === "") rel = "./";
        else if (!rel.endsWith("/")) rel += "/";
      }
    } catch {
      // keep path as-is
    }
    refs.push(rel);
  }
  await sendRefs(refs);
}

async function sendFromEditor(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const docUri = normalizeUri(editor.document.uri);
  if (docUri.scheme !== "file") return;
  const rel = relRefForUri(docUri);
  const sel = editor.selection;
  let ref: string;
  if (sel.isEmpty) {
    ref = formatRef(rel, sel.active.line + 1);
  } else {
    const start = sel.start.line + 1;
    let end = sel.end.line + 1;
    if (sel.end.character === 0 && end > start) {
      end -= 1;
    }
    ref = formatRef(rel, start, end);
  }
  await sendRefs([ref]);
}

async function sendHunk(): Promise<void> {
  try {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      await sendFromEditor();
      return;
    }

    const docUri = normalizeUri(editor.document.uri);
    if (docUri.scheme !== "file") {
      await sendFromEditor();
      return;
    }

    const cursorLine = editor.selection.active.line + 1;
    const gitExtension = vscode.extensions.getExtension("vscode.git");
    if (!gitExtension) {
      await sendFromEditor();
      return;
    }
    await gitExtension.activate();
    const api = gitExtension.exports.getAPI(1) as {
      repositories: Array<{
        rootUri: vscode.Uri;
        diffWithHEAD: (path: string) => Promise<string | undefined>;
      }>;
    };
    const candidates = api.repositories.filter((entry) =>
      isPathInside(entry.rootUri.fsPath, docUri.fsPath),
    );
    candidates.sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length);
    const repo = candidates[0];
    if (!repo) {
      await sendFromEditor();
      return;
    }

    const patch = await repo.diffWithHEAD(docUri.fsPath);
    if (!patch) {
      await sendFromEditor();
      return;
    }

    const hunks = parseHunks(patch);
    // Left-pane cursor lines are old-side numbers; findHunkForNewLine uses new-side ranges.
    const hunk = findHunkForNewLine(hunks, cursorLine);
    if (!hunk) {
      await sendFromEditor();
      return;
    }

    const [start, end] = hunkNewRange(hunk);
    const rel = relRefForUri(docUri);
    await sendRefs([formatRef(rel, start, end)]);
  } catch {
    await sendFromEditor();
  }
}

function handleConnection(socket: net.Socket): void {
  socket.setEncoding("utf8");
  const split = createFrameSplitter();
  let greeted = false;

  socket.on("data", (chunk: string) => {
    try {
      for (const line of split(chunk)) {
        const message = parseClientMessage(line);
        if (!message || typeof message.type !== "string") continue;

        if (!greeted) {
          if (message.type !== "hello") {
            rejectSocket(socket, "Expected hello as the first message.");
            return;
          }

          const hello = parseHello(message);
          if (!hello) {
            rejectSocket(socket, "Malformed hello message.");
            return;
          }
          if (hello.protocol !== PROTOCOL_VERSION) {
            rejectSocket(socket, `Unsupported protocol version ${hello.protocol}.`);
            return;
          }
          if (!foldersAcceptCwd(hello.piCwd)) {
            rejectSocket(
              socket,
              "Pi working directory is not related to any open VS Code workspace folder.",
            );
            return;
          }

          evictAttached("superseded");
          greeted = true;
          attached = { socket, hello };
          socket.write(
            encodeFrame({
              type: "welcome",
              protocol: PROTOCOL_VERSION,
              workspaceFolders: workspaceFolders(),
            }),
          );
          updateStatusBar();
          continue;
        }

        if (message.type === "bye") {
          if (attached?.socket === socket) {
            attached = undefined;
            updateStatusBar();
          }
          socket.end();
        }
      }
    } catch {
      socket.destroy();
    }
  });

  socket.on("close", () => {
    if (attached?.socket === socket) {
      attached = undefined;
      updateStatusBar();
    }
  });

  socket.on("error", () => {
    if (attached?.socket === socket) {
      attached = undefined;
      updateStatusBar();
    }
    socket.destroy();
  });
}

async function showStatus(): Promise<void> {
  if (!attached) {
    await vscode.window.showWarningMessage("No Pi agent is attached.");
    return;
  }
  const message = `Attached to Pi (pid ${attached.hello.pid})\nCWD: ${attached.hello.piCwd}\nSession: ${attached.hello.sessionFile ?? "(none)"}`;
  const choice = await vscode.window.showInformationMessage(message, "Detach");
  if (choice === "Detach") {
    evictAttached("server-shutdown");
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const dir = bridgeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  socketPath = path.join(dir, `${process.pid}.sock`);
  registryPath = path.join(dir, `${process.pid}.json`);
  startedAt = Date.now();

  try {
    fs.unlinkSync(socketPath);
  } catch {
    // stale socket from a crashed host
  }

  server = net.createServer(handleConnection);
  server.on("listening", () => {
    writeRegistry();
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    void vscode.window.showErrorMessage(
      `Pi Bridge could not listen on ${socketPath}: ${error.message}`,
    );
    server = undefined;
    if (registryPath) {
      try {
        fs.unlinkSync(registryPath);
      } catch {
        // ignore cleanup errors
      }
    }
  });
  server.listen(socketPath);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "pi-vscode-bridge.showStatus";
  context.subscriptions.push(statusBar);

  const folderListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    writeRegistry();
  });
  context.subscriptions.push(folderListener);

  context.subscriptions.push(
    vscode.commands.registerCommand("pi-vscode-bridge.sendFromExplorer", sendFromExplorer),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-vscode-bridge.sendFromEditor", sendFromEditor),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-vscode-bridge.sendHunk", sendHunk),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-vscode-bridge.showStatus", showStatus),
  );

  context.subscriptions.push({
    dispose: () => {
      evictAttached("server-shutdown");
      server?.close();
      server = undefined;
      if (socketPath) {
        try {
          fs.unlinkSync(socketPath);
        } catch {
          // ignore cleanup errors
        }
      }
      if (registryPath) {
        try {
          fs.unlinkSync(registryPath);
        } catch {
          // ignore cleanup errors
        }
      }
    },
  });
}

export function deactivate(): void {
  evictAttached("server-shutdown");
  server?.close();
  server = undefined;
  if (socketPath) {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // ignore cleanup errors
    }
  }
  if (registryPath) {
    try {
      fs.unlinkSync(registryPath);
    } catch {
      // ignore cleanup errors
    }
  }
}
