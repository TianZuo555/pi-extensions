// A/B harness: run the SAME (file, edits) through pi's real built-in edit
// pipeline AND pi-edit-safe, then report where they diverge.
//
// The built-in path is NOT a reconstruction — it imports pi's actual shipped
// functions (stripBom / detectLineEnding / normalizeToLF / restoreLineEndings /
// applyEditsToNormalizedContent) from the installed @earendil-works/pi-coding-agent
// dist and composes them exactly as dist/core/tools/edit.js does (lines 202-207).
//
// Run:  npm run bench
//
// What it surfaces:
//   - cases where one tool throws and the other silently applies (ambiguity)
//   - cases where both apply but produce different bytes (corruption / normalization)
//   - "canary" lines that must stay byte-identical to the original (the #3554 class)

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdits, type EditRequest } from "../lib/edit-replace.ts";

type RunResult = { ok: true; content: string } | { ok: false; err: string };
type EditRunner = (rawContent: string, edits: EditRequest[], path: string) => string;

// exports map blocks ./package.json and only defines an `import` condition, so use
// ESM resolution (import.meta.resolve) rather than CJS require.resolve.
const mainPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const pkgRoot = dirname(dirname(mainPath)); // dist/index.js → dist → package root
const B = await import(join(pkgRoot, "dist/core/tools/edit-diff.js"));

// --- faithful reproduction of dist/core/tools/edit.js execute() core (202-207) ---
function runBuiltin(rawContent: string, edits: EditRequest[], path: string): string {
  const { bom, text: content } = B.stripBom(rawContent);
  const originalEnding = B.detectLineEnding(content);
  const normalizedContent = B.normalizeToLF(content);
  const { newContent } = B.applyEditsToNormalizedContent(normalizedContent, edits, path);
  return bom + B.restoreLineEndings(newContent, originalEnding);
}

function runSafe(rawContent: string, edits: EditRequest[], path: string): string {
  return applyEdits(rawContent, edits, path).content;
}

// both tools take (rawBytesAsString, edits, label) and may throw.
function tryRun(
  fn: EditRunner,
  rawContent: string,
  edits: EditRequest[],
  label: string,
): RunResult {
  try {
    return { ok: true, content: fn(rawContent, edits, label) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, err: message.split("\n")[0] };
  }
}

function short(s: string, n = 48): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// byte-diff at line granularity, returns changed line numbers (1-based) of `b` vs `a`.
function changedLineNos(a: string, b: string): number[] {
  const al = a.split("\n");
  const bl = b.split("\n");
  const set = new Set<number>();
  const n = Math.max(al.length, bl.length);
  for (let i = 0; i < n; i++) {
    if (al[i] !== bl[i]) set.add(i + 1);
  }
  return [...set];
}

// --- corpus: each case targets a known behavior boundary ---
const cases = [
  {
    name: "01 exact unique (baseline agreement)",
    file: "const a = 1;\nconst b = 2;\nconst c = 3;\n",
    edits: [{ oldText: "const b = 2;", newText: "const b = 20;" }],
    canary: [1, 3], // lines that must stay byte-identical
  },
  {
    name: "02 ambiguity: oldText appears 3x (tui.go / #1261 class)",
    file: "func a() {\n\tprepare()\n}\nfunc b() {\n\tprepare()\n}\nfunc c() {\n\tprepare()\n}\n",
    edits: [{ oldText: "\tprepare()", newText: "\tprepare(ctx)" }],
    // safe MUST throw not-unique; builtin behavior is the open question.
  },
  {
    name: "03 #3554 corruption: edit one line, smart quotes/em-dash elsewhere",
    // oldText drifts (tab vs spaces) to FORCE fuzzy on the name line; lines 1,3,4
    // have smart quotes / em-dash / NBSP that must NOT be normalized.
    file:
      'const greeting = "Hi";\n' +
      'const name = "Alice";\n' +
      "// \u201csmart\u201d and em\u2014dash here\n" +
      "// non\u00a0breaking space\n",
    edits: [{ oldText: 'const name = "Alice";', newText: 'const name = "Bob";' }],
    canary: [1, 3, 4],
  },
  {
    name: "04 whitespace drift, unique (both fuzzy)",
    file: "const x =    a   +   b;\nconst y = 2;\n",
    edits: [{ oldText: "const x = a + b;", newText: "const x = a - b;" }],
    canary: [2],
  },
  {
    name: "05 binary file (NUL byte), non-exact oldText",
    file: "header\n\x00\x01 binary\x00\ntrailer\n",
    edits: [{ oldText: "header notpresent long", newText: "x" }],
    // safe MUST refuse fuzzy on binary.
  },
  {
    name: "06 overlapping edits",
    file: "function f() {\n  return 1;\n}\n",
    edits: [
      { oldText: "function f() {\n  return 1;\n}", newText: "x" },
      { oldText: "return 1;", newText: "return 2;" },
    ],
    // both should throw: builtin as overlap (parallel), safe as an
    // earlier-edit-consumed-this-text error (sequential).
  },
  {
    name: "07 CRLF file, LF oldText",
    file: "const a = 1;\r\nconst b = 2;\r\n",
    edits: [{ oldText: "const b = 2;", newText: "const b = 3;" }],
    canary: [1],
  },
  {
    name: "08 multi-edit disjoint (baseline agreement)",
    file: "import a from 'a';\nimport b from 'b';\nimport c from 'c';\n",
    edits: [
      { oldText: "import a from 'a';", newText: "import a from 'x';" },
      { oldText: "import c from 'c';", newText: "import c from 'z';" },
    ],
    canary: [2],
  },
  {
    name: "09 unicode punctuation drift: ASCII oldText vs smart quotes/em-dash in file",
    file: "Title \u201cQuoted\u201d \u2014 subtitle\nsecond line\nthird line\n",
    edits: [{ oldText: 'Title "Quoted" - subtitle', newText: 'Title "Renamed" - subtitle' }],
    canary: [2, 3],
  },
  {
    name: "10 CRLF file + indent drift (fuzzy must keep \\r\\n intact)",
    file: "function f() {\r\n    return 1;\r\n}\r\nconst keep = true;\r\n",
    edits: [
      { oldText: "function f() {\n  return 1;\n}", newText: "function f() {\n    return 2;\n}" },
    ],
    canary: [4],
  },
  {
    name: "11 mixed line endings: exact edit must not flatten untouched terminators",
    file: "a = 1;\r\nb = 2;\nc = 3;\r\n",
    edits: [{ oldText: "a = 1;", newText: "a = 10;" }],
    canary: [2, 3],
  },
  {
    name: "12 dependent edits: edit 2 targets edit 1's output (sequential contract)",
    file: "const value = 1;\nconst other = 9;\n",
    edits: [
      { oldText: "const value = 1;", newText: "const value = 2;" },
      { oldText: "const value = 2;", newText: "export const value = 2;" },
    ],
    // builtin matches all edits against the ORIGINAL file → edit 2 not found;
    // safe applies edits in order → both succeed.
    canary: [2],
  },
];

// --- run + report ---
const rows = [];
let divergences = 0;

for (const c of cases) {
  const builtin = tryRun(runBuiltin, c.file, c.edits, c.name);
  const safe = tryRun(runSafe, c.file, c.edits, c.name);

  const bStatus = builtin.ok ? "APPLIED" : `THREW`;
  const sStatus = safe.ok ? "APPLIED" : `THREW`;

  let bytesMatch = "—";
  if (builtin.ok && safe.ok) {
    bytesMatch = builtin.content === safe.content ? "identical" : "DIFFER";
  }

  // canary check: which tool corrupted untouched lines?
  const canaryReport = (c.canary ?? []).map((ln) => {
    const origLine = c.file.split("\n")[ln - 1];
    const bLine = builtin.ok ? builtin.content.split("\n")[ln - 1] : null;
    const sLine = safe.ok ? safe.content.split("\n")[ln - 1] : null;
    return {
      ln,
      builtin: !builtin.ok ? "threw" : bLine === origLine ? "ok" : "CORRUPTED",
      safe: !safe.ok ? "threw" : sLine === origLine ? "ok" : "CORRUPTED",
    };
  });

  const diverged =
    bStatus !== sStatus ||
    bytesMatch === "DIFFER" ||
    canaryReport.some((r) => r.builtin === "CORRUPTED" || r.safe === "CORRUPTED");
  if (diverged) divergences++;

  rows.push({ ...c, builtin, safe, bStatus, sStatus, bytesMatch, canaryReport, diverged });
}

// print
const W = (s: unknown, n: number) => String(s).padEnd(n);
console.log("\n=== pi-edit-safe vs built-in edit (real dist functions) ===\n");
for (const r of rows) {
  const flag = r.diverged ? "⚠️  DIVERGE" : "✓  agree ";
  console.log(`${flag}  ${r.name}`);
  console.log(
    `        built-in : ${W(r.bStatus, 8)} ${r.builtin.ok ? "" : `→ ${short(r.builtin.err, 60)}`}`,
  );
  console.log(
    `        safe     : ${W(r.sStatus, 8)} ${r.safe.ok ? "" : `→ ${short(r.safe.err, 60)}`}`,
  );
  if (r.builtin.ok && r.safe.ok) {
    console.log(`        bytes    : ${r.bytesMatch}`);
  }
  if (r.canaryReport.length) {
    const parts = r.canaryReport.map((x) => `L${x.ln}(b:${x.builtin},s:${x.safe})`).join("  ");
    console.log(`        canary   : ${parts}`);
  }
  if (r.diverged && r.builtin.ok && r.safe.ok && r.bytesMatch === "DIFFER") {
    const bCh = changedLineNos(r.file, r.builtin.content);
    const sCh = changedLineNos(r.file, r.safe.content);
    console.log(
      `        builtin touched lines: [${bCh.join(",")}]   safe touched lines: [${sCh.join(",")}]`,
    );
  }
  console.log();
}

console.log(
  `Summary: ${cases.length} cases, ${divergences} divergent, ${cases.length - divergences} in agreement.`,
);
console.log(
  `Divergences are where pi-edit-safe changes behavior vs the current built-in — review each before daily use.`,
);
