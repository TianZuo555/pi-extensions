import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const EXTENSION_ID = "tianzuo.pi-tian-vscode-review";
const REVIEW_COMMAND = "pi-vscode-review.open";

interface ReviewAnnotation {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  side: "old" | "new";
  text: string;
  suggestedCode?: string;
}

interface ReviewRequest {
  reviewId: string;
  cwd: string;
  diffLabel: string;
  patch: string;
}

interface ReviewConnection {
  reviewId: string;
  endpoint: string;
  token: string;
}

interface ReviewSubmission {
  decision: "feedback" | "approved" | "cancelled";
  annotations: ReviewAnnotation[];
}

let activePanel: ReviewPanel | undefined;

function nonce(): string {
  return randomBytes(16).toString("hex");
}

async function getJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: { "x-pi-vscode-token": token },
  });
  if (!response.ok) {
    throw new Error(`Pi review server returned HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function postJson(
  url: string,
  token: string,
  body: unknown,
): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-pi-vscode-token": token,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Pi review server returned HTTP ${response.status}`);
  }
}

function parseConnection(uri: vscode.Uri): ReviewConnection | undefined {
  const query = new URLSearchParams(uri.query);
  const reviewId = query.get("reviewId");
  const port = query.get("port");
  const token = query.get("token");
  if (!reviewId || !port || !token || !/^\d+$/.test(port)) return undefined;
  return {
    reviewId,
    endpoint: `http://127.0.0.1:${port}`,
    token,
  };
}

class ReviewPanel {
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connection: ReviewConnection,
    private readonly request: ReviewRequest,
    private readonly assets: { script: string; style: string },
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "piVscodeReview",
      "Pi Review",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      },
    );

    // Register the message handler before assigning HTML. The webview script
    // sends `ready` immediately, so assigning HTML first can lose that message
    // on fast loads and leave the panel stuck on its loading screen.
    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => void this.handleMessage(message),
      undefined,
      context.subscriptions,
    );
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => {
      this.disposed = true;
      if (activePanel === this) activePanel = undefined;
    }, undefined, context.subscriptions);

  }

  static async open(
    context: vscode.ExtensionContext,
    connection: ReviewConnection,
  ): Promise<void> {
    const [request, script, style] = await Promise.all([
      getJson<ReviewRequest>(
        `${connection.endpoint}/v1/reviews/${encodeURIComponent(connection.reviewId)}`,
        connection.token,
      ),
      readFile(join(context.extensionPath, "vscode", "media", "review.js"), "utf8"),
      readFile(join(context.extensionPath, "vscode", "media", "review.css"), "utf8"),
    ]);
    activePanel?.dispose();
    activePanel = new ReviewPanel(context, connection, request, { script, style });
  }

  dispose(): void {
    if (!this.disposed) this.panel.dispose();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") return;
    const input = message as { type?: string; submission?: ReviewSubmission };
    if (input.type === "ready") {
      await this.panel.webview.postMessage({ type: "review", request: this.request });
      return;
    }
    if (input.type !== "submit" || !input.submission) return;

    try {
      await postJson(
        `${this.connection.endpoint}/v1/reviews/${encodeURIComponent(this.connection.reviewId)}/${input.submission.decision === "cancelled" ? "cancel" : "submit"}`,
        this.connection.token,
        input.submission,
      );
      this.panel.webview.postMessage({ type: "submitted" });
      this.dispose();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await vscode.window.showErrorMessage(`Could not send Pi review: ${text}`);
    }
  }

  private html(): string {
    const securityNonce = nonce();
    const script = this.assets.script.replaceAll("</script", "<\\/script");
    const style = this.assets.style.replaceAll("</style", "<\\/style");

    return `<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${securityNonce}';">
<title>Pi Review</title>
<style>${style}</style>
</head>
<body>
<div id="app"><p>Loading Pi review…</p></div>
<script nonce="${securityNonce}">${script}</script>
</body>
</html>`;
  }
}

async function openReview(
  context: vscode.ExtensionContext,
  uri: vscode.Uri,
): Promise<void> {
  const connection = parseConnection(uri);
  if (!connection) {
    await vscode.window.showErrorMessage("Invalid Pi VS Code review URI.");
    return;
  }

  try {
    await ReviewPanel.open(context, connection);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    await vscode.window.showErrorMessage(`Could not open Pi review: ${text}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(REVIEW_COMMAND, async () => {
      await vscode.window.showInformationMessage(
        "Run /vscode-review in Pi to open a review in this window.",
      );
    }),
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
        if (uri.authority !== EXTENSION_ID || uri.path !== "/start") return;
        return openReview(context, uri);
      },
    }),
  );
}

export function deactivate(): void {
  activePanel?.dispose();
  activePanel = undefined;
}
