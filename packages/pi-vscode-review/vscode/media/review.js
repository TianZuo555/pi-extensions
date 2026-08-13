(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  let request;
  let files = [];
  let selection = null;
  let annotations = [];
  let sending = false;
  let status = "";

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function parsePath(value) {
    if (!value || value === "/dev/null") return undefined;
    return value.replace(/^([ab])\\//, "");
  }

  function parsePatch(patch) {
    const parsed = [];
    let file;
    let hunk;

    for (const rawLine of patch.split(/\r?\n/)) {
      if (rawLine.startsWith("diff --git ")) {
        const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(rawLine);
        const oldPath = match ? parsePath(match[1]) : undefined;
        const newPath = match ? parsePath(match[2]) : undefined;
        file = {
          path: newPath || oldPath || "(unknown file)",
          oldPath: oldPath || newPath || "(unknown file)",
          hunks: [],
        };
        parsed.push(file);
        hunk = undefined;
        continue;
      }

      if (!file) continue;
      if (rawLine.startsWith("--- ")) {
        const oldPath = parsePath(rawLine.slice(4).trim());
        if (oldPath) file.oldPath = oldPath;
        continue;
      }
      if (rawLine.startsWith("+++ ")) {
        const newPath = parsePath(rawLine.slice(4).trim());
        if (newPath) file.path = newPath;
        else file.path = file.oldPath;
        continue;
      }

      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(rawLine);
      if (header) {
        hunk = {
          header: rawLine,
          oldStart: Number(header[1]),
          newStart: Number(header[3]),
          lines: [],
        };
        file.hunks.push(hunk);
        continue;
      }
      if (!hunk || rawLine.startsWith("\\")) continue;

      const prefix = rawLine[0];
      const text = rawLine.slice(1);
      if (prefix === " ") {
        hunk.lines.push({ type: "context", text, oldNo: hunk.oldStart, newNo: hunk.newStart });
        hunk.oldStart += 1;
        hunk.newStart += 1;
      } else if (prefix === "-") {
        hunk.lines.push({ type: "delete", text, oldNo: hunk.oldStart });
        hunk.oldStart += 1;
      } else if (prefix === "+") {
        hunk.lines.push({ type: "add", text, newNo: hunk.newStart });
        hunk.newStart += 1;
      }
    }
    return parsed;
  }

  function sideName(side) {
    return side === "new" ? "new" : "old";
  }

  function selectedRangeLabel() {
    if (!selection) return "Select a line, range, or hunk to add feedback.";
    const range = selection.start === selection.end
      ? `line ${selection.start}`
      : `lines ${selection.start}-${selection.end}`;
    return `Selected ${range} (${sideName(selection.side)}) in ${selection.filePath}`;
  }

  function lineButton(filePath, line, side) {
    const number = side === "new" ? line.newNo : line.oldNo;
    if (number === undefined) return "<span class=\"line-number empty\"></span>";
    const active = selection &&
      selection.filePath === filePath &&
      selection.side === side &&
      number >= selection.start && number <= selection.end;
    return `<button class="line-number ${active ? "selected" : ""}" data-line="${number}" data-side="${side}" data-file="${escapeHtml(filePath)}">${number}</button>`;
  }

  function renderLine(filePath, line) {
    const className = line.type === "add" ? "add" : line.type === "delete" ? "delete" : "context";
    const oldNumber = lineButton(filePath, line, "old");
    const newNumber = lineButton(filePath, line, "new");
    const prefix = line.type === "add" ? "+" : line.type === "delete" ? "-" : " ";
    return `<div class="diff-line ${className}">
      <div class="number-cell old-number">${oldNumber}</div>
      <div class="number-cell new-number">${newNumber}</div>
      <code class="code"><span class="prefix">${prefix}</span>${escapeHtml(line.text)}</code>
    </div>`;
  }

  function renderHunk(file, hunk, hunkIndex) {
    const changed = hunk.lines.filter((line) => line.type !== "context");
    const canSelect = changed.length > 0;
    return `<section class="hunk">
      <div class="hunk-header">
        <code>${escapeHtml(hunk.header)}</code>
        ${canSelect ? `<button class="secondary select-hunk" data-file="${escapeHtml(file.path)}" data-hunk="${hunkIndex}">Select hunk</button>` : ""}
      </div>
      ${hunk.lines.map((line) => renderLine(file.path, line)).join("")}
    </section>`;
  }

  function renderFile(file, fileIndex) {
    return `<article class="file-card" id="file-${fileIndex}">
      <header class="file-header">
        <span class="file-status">${file.hunks.some((hunk) => hunk.lines.some((line) => line.type === "add")) ? "+" : "~"}</span>
        <strong>${escapeHtml(file.path)}</strong>
        ${file.oldPath !== file.path ? `<span class="muted">from ${escapeHtml(file.oldPath)}</span>` : ""}
      </header>
      ${file.hunks.map((hunk, index) => renderHunk(file, hunk, index)).join("")}
    </article>`;
  }

  function renderAnnotation(annotation, index) {
    const range = annotation.lineStart === annotation.lineEnd
      ? `Line ${annotation.lineStart}`
      : `Lines ${annotation.lineStart}-${annotation.lineEnd}`;
    return `<li class="annotation">
      <div class="annotation-heading"><strong>${escapeHtml(annotation.filePath)}</strong><span>${range} (${annotation.side})</span></div>
      <p>${escapeHtml(annotation.text)}</p>
      ${annotation.suggestedCode ? `<pre>${escapeHtml(annotation.suggestedCode)}</pre>` : ""}
      <button class="link remove-annotation" data-index="${index}">Remove</button>
    </li>`;
  }

  function renderComposer() {
    if (!selection) return "";
    return `<section class="composer">
      <div class="selection-label">${escapeHtml(selectedRangeLabel())}</div>
      <textarea id="comment" rows="3" placeholder="Explain what the agent should change…"></textarea>
      <textarea id="suggested-code" rows="4" placeholder="Optional suggested code"></textarea>
      <div class="composer-actions"><button id="add-comment" class="primary">Add comment</button><button id="clear-selection" class="secondary">Clear selection</button></div>
    </section>`;
  }

  function render() {
    if (!request || !app) return;
    const fileLinks = files.map((file, index) => `<a href="#file-${index}">${escapeHtml(file.path)}</a>`).join("");
    const annotationBlock = annotations.length === 0
      ? "<p class=\"muted\">No annotations yet.</p>"
      : `<ol class="annotations">${annotations.map(renderAnnotation).join("")}</ol>`;

    app.innerHTML = `<header class="toolbar">
      <div><h1>Pi Review</h1><p class="muted">${escapeHtml(request.diffLabel)} · ${escapeHtml(request.cwd)}</p></div>
      <div class="top-actions"><button id="approve" class="secondary" ${sending ? "disabled" : ""}>Approve</button><button id="send" class="primary" ${sending || annotations.length === 0 ? "disabled" : ""}>Send feedback</button><button id="cancel" class="link" ${sending ? "disabled" : ""}>Cancel</button></div>
    </header>
    <div class="layout">
      <aside class="file-list"><h2>Files</h2>${fileLinks}</aside>
      <main class="review"><div class="selection-help">${escapeHtml(selectedRangeLabel())}</div>${files.map(renderFile).join("")}</main>
      <aside class="sidebar"><h2>Annotations <span class="count">${annotations.length}</span></h2>${annotationBlock}${renderComposer()}</aside>
    </div>
    ${status ? `<div class="status">${escapeHtml(status)}</div>` : ""}`;

    app.querySelectorAll(".line-number").forEach((element) => {
      element.addEventListener("click", () => {
        const button = element;
        const filePath = button.dataset.file;
        const side = button.dataset.side === "new" ? "new" : "old";
        const line = Number(button.dataset.line);
        if (!filePath || !Number.isInteger(line)) return;
        if (!selection || selection.filePath !== filePath || selection.side !== side) {
          selection = { filePath, side, start: line, end: line };
        } else {
          selection = { ...selection, start: Math.min(selection.start, line), end: Math.max(selection.end, line) };
        }
        render();
      });
    });

    app.querySelectorAll(".select-hunk").forEach((element) => {
      element.addEventListener("click", () => {
        const button = element;
        const file = files.find((candidate) => candidate.path === button.dataset.file);
        const hunk = file?.hunks[Number(button.dataset.hunk)];
        if (!file || !hunk) return;
        const additions = hunk.lines.filter((line) => line.type === "add" && line.newNo !== undefined);
        const deletions = hunk.lines.filter((line) => line.type === "delete" && line.oldNo !== undefined);
        const selected = additions.length > 0 ? additions : deletions;
        if (selected.length === 0) return;
        const side = additions.length > 0 ? "new" : "old";
        const numbers = selected.map((line) => side === "new" ? line.newNo : line.oldNo);
        selection = { filePath: file.path, side, start: Math.min(...numbers), end: Math.max(...numbers) };
        render();
      });
    });

    app.querySelector("#add-comment")?.addEventListener("click", () => {
      if (!selection) return;
      const text = app.querySelector("#comment")?.value.trim();
      const suggestedCode = app.querySelector("#suggested-code")?.value.trim();
      if (!text) {
        status = "Write a comment before adding the annotation.";
        render();
        return;
      }
      annotations.push({ ...selection, text, suggestedCode: suggestedCode || undefined });
      selection = null;
      status = "Annotation added.";
      render();
    });

    app.querySelector("#clear-selection")?.addEventListener("click", () => {
      selection = null;
      render();
    });

    app.querySelectorAll(".remove-annotation").forEach((element) => {
      element.addEventListener("click", () => {
        annotations.splice(Number(element.dataset.index), 1);
        render();
      });
    });

    app.querySelector("#send")?.addEventListener("click", () => submit("feedback"));
    app.querySelector("#approve")?.addEventListener("click", () => submit("approved"));
    app.querySelector("#cancel")?.addEventListener("click", () => submit("cancelled"));
  }

  function submit(decision) {
    if (sending) return;
    sending = true;
    status = "Sending review to Pi…";
    render();
    vscode.postMessage({
      type: "submit",
      submission: { decision, annotations: decision === "feedback" ? annotations : [] },
    });
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.type !== "review") return;
    request = message.request;
    files = parsePatch(request.patch);
    render();
  });

  vscode.postMessage({ type: "ready" });
})();
