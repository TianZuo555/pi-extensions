import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewAnnotation, ReviewRequest, ReviewSubmission } from "./protocol.ts";
import { formatApproval, formatReviewFeedback } from "./lib/feedback.ts";

const VSCODE_URI = "vscode://tianzuo.pi-tian-vscode-review/start";
const MAX_BODY_BYTES = 1_000_000;
const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

type PendingReview = {
  request: ReviewRequest;
  token: string;
  resolve: (submission: ReviewSubmission) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

let server: Server | undefined;
let serverPort: number | undefined;
let pendingReview: PendingReview | undefined;

function randomId(): string {
  return randomBytes(18).toString("base64url");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(body);
}

function requestToken(request: IncomingMessage, url: URL): string | undefined {
  const header = request.headers["x-pi-vscode-token"];
  if (typeof header === "string") return header;
  if (Array.isArray(header)) return header[0];
  return url.searchParams.get("token") ?? undefined;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");

    request.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        reject(new Error("request body is too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function normalizeSubmission(value: unknown): ReviewSubmission {
  if (!value || typeof value !== "object") {
    throw new Error("submission must be an object");
  }

  const input = value as Partial<ReviewSubmission>;
  if (input.decision !== "feedback" && input.decision !== "approved" && input.decision !== "cancelled") {
    throw new Error("submission decision must be feedback, approved, or cancelled");
  }
  if (!Array.isArray(input.annotations)) {
    throw new Error("submission annotations must be an array");
  }

  const annotations: ReviewAnnotation[] = input.annotations.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`annotation ${index} must be an object`);
    const annotation = item as Partial<ReviewAnnotation>;
    const { filePath, lineStart, lineEnd, side, text, suggestedCode } = annotation;
    if (
      typeof filePath !== "string" ||
      typeof lineStart !== "number" ||
      typeof lineEnd !== "number" ||
      !Number.isInteger(lineStart) ||
      !Number.isInteger(lineEnd) ||
      lineStart < 1 ||
      lineEnd < lineStart ||
      (side !== "old" && side !== "new") ||
      typeof text !== "string"
    ) {
      throw new Error(`annotation ${index} has invalid location or text`);
    }
    if (filePath.length > 4_000 || text.length > 20_000) {
      throw new Error(`annotation ${index} is too large`);
    }
    if (suggestedCode !== undefined && typeof suggestedCode !== "string") {
      throw new Error(`annotation ${index} suggestedCode must be a string`);
    }
    return {
      filePath,
      lineStart,
      lineEnd,
      side,
      text,
      suggestedCode,
    };
  });

  return { decision: input.decision, annotations };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts[0] !== "v1" || parts[1] !== "reviews" || !parts[2]) {
    sendJson(response, 404, { error: "not found" });
    return;
  }

  const current = pendingReview;
  if (!current || current.request.reviewId !== decodeURIComponent(parts[2])) {
    sendJson(response, 404, { error: "review not found" });
    return;
  }
  if (requestToken(request, url) !== current.token) {
    sendJson(response, 401, { error: "invalid review token" });
    return;
  }

  const action = parts[3];
  if (request.method === "GET" && !action) {
    sendJson(response, 200, current.request);
    return;
  }
  if (request.method !== "POST" || (action !== "submit" && action !== "cancel")) {
    sendJson(response, 405, { error: "method not allowed" });
    return;
  }

  let submission: ReviewSubmission;
  try {
    submission = action === "cancel"
      ? { decision: "cancelled", annotations: [] }
      : normalizeSubmission(JSON.parse(await readBody(request)));
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  sendJson(response, 202, { accepted: true });
  current.resolve(submission);
}

async function ensureServer(): Promise<number> {
  if (server && serverPort !== undefined) return serverPort;

  server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      } else {
        response.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const activeServer = server;
    if (!activeServer) {
      reject(new Error("review server was not created"));
      return;
    }
    activeServer.once("error", reject);
    activeServer.listen(0, "127.0.0.1", () => {
      activeServer.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer();
    throw new Error("review server did not expose a TCP port");
  }
  serverPort = address.port;
  return address.port;
}

async function closeServer(): Promise<void> {
  const activeServer = server;
  server = undefined;
  serverPort = undefined;
  if (!activeServer) return;

  await new Promise<void>((resolve) => {
    activeServer.close(() => resolve());
  });
}

function buildVscodeUri(reviewId: string, port: number, token: string): string {
  const query = new URLSearchParams({
    reviewId,
    port: String(port),
    token,
  });
  return `${VSCODE_URI}?${query.toString()}`;
}

async function openVscode(uri: string, pi: ExtensionAPI): Promise<void> {
  const args = process.platform === "darwin"
    ? [uri]
    : process.platform === "win32"
      ? ["/d", "/c", "start", "", uri]
      : [uri];
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd.exe" : "xdg-open";
  const result = await pi.exec(command, args, { timeout: 5_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `could not open VS Code URI (exit ${result.code})`);
  }
}

function waitForSubmission(request: ReviewRequest, token: string): Promise<ReviewSubmission> {
  if (pendingReview) throw new Error("a VS Code review is already open");

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingReview?.request.reviewId !== request.reviewId) return;
      pendingReview = undefined;
      reject(new Error("VS Code review timed out after 30 minutes"));
    }, REVIEW_TIMEOUT_MS);
    pendingReview = { request, token, resolve, reject, timer };
  });
}

async function finishPendingReview(): Promise<void> {
  const current = pendingReview;
  pendingReview = undefined;
  if (current) clearTimeout(current.timer);
  await closeServer();
}

function reportError(ctx: ExtensionContext, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`VS Code review failed: ${message}`, "error");
}

export default function piVscodeReviewExtension(pi: ExtensionAPI): void {
  pi.registerCommand("vscode-review", {
    description: "Review the current Git diff in VS Code and send feedback back to pi",
    handler: async (_args, ctx) => {
      if (pendingReview) {
        ctx.ui.notify("A VS Code review is already open.", "warning");
        return;
      }

      try {
        const diff = await pi.exec(
          "git",
          ["diff", "--no-ext-diff", "--unified=80", "HEAD", "--"],
          { signal: ctx.signal, timeout: 10_000 },
        );
        if (diff.code !== 0) {
          throw new Error(diff.stderr.trim() || `git diff exited with ${diff.code}`);
        }
        if (!diff.stdout.trim()) {
          ctx.ui.notify("No tracked Git changes found in the current worktree.", "info");
          return;
        }

        const request: ReviewRequest = {
          reviewId: randomId(),
          cwd: ctx.cwd,
          diffLabel: "Current worktree changes (git diff HEAD)",
          patch: diff.stdout,
        };
        const token = randomBytes(32).toString("base64url");
        const port = await ensureServer();
        const submissionPromise = waitForSubmission(request, token);
        const uri = buildVscodeUri(request.reviewId, port, token);

        ctx.ui.notify("Opening the VS Code review panel…", "info");
        await openVscode(uri, pi);

        const submission = await submissionPromise;
        if (submission.decision === "cancelled") {
          ctx.ui.notify("VS Code review cancelled.", "info");
          return;
        }

        const message = submission.decision === "approved"
          ? formatApproval(request)
          : formatReviewFeedback(request, submission.annotations);
        const delivery = ctx.isIdle() ? undefined : { deliverAs: "followUp" as const };
        pi.sendUserMessage(message, delivery);
        ctx.ui.notify(
          submission.decision === "approved" ? "Review approved and sent to pi." : "Review feedback sent to pi.",
          "info",
        );
      } catch (error) {
        reportError(ctx, error);
      } finally {
        await finishPendingReview();
      }
    },
  });

  pi.on("session_shutdown", async () => {
    const current = pendingReview;
    pendingReview = undefined;
    if (current) {
      clearTimeout(current.timer);
      current.reject(new Error("Pi session shut down while the VS Code review was open"));
    }
    await closeServer();
  });
}
