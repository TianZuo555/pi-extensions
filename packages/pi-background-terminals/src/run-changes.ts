/**
 * Files changed by the model's own `edit` / `write` calls while a command was
 * running.
 *
 * A test that finishes after the code under test changed can report a pass for
 * code that no longer exists, and nothing in the transcript says so. This
 * tracker records only the fact and the path; the result states it so the
 * model can decide whether to run the command again. It deliberately does not
 * re-run anything, change a status, or infer dependencies.
 *
 * Each change is attached to every command running when it lands, not to an
 * agent run: a command can start in one run and settle in a later one. A
 * terminal's changes are forgotten once the manager prunes it from history.
 *
 * Only `edit` / `write` calls are observed. A file changed by the command
 * itself or by another shell command (`sed -i`, `cargo fmt`, `git apply`) is
 * invisible here — proving that would need filesystem snapshots.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { TerminalSnapshot } from "./domain.ts";

/**
 * Resolve an `edit` / `write` path argument the way Pi's tools do. Pi's
 * `resolveToCwd` is not exported, so this mirrors the parts that change the
 * target: a leading `@` is dropped and `~` is the home directory.
 */
export function resolveToolPath(input: string, cwd: string) {
  let target = input.startsWith("@") ? input.slice(1) : input;
  if (target === "~") {
    target = os.homedir();
  } else if (
    target.startsWith("~/") ||
    (process.platform === "win32" && target.startsWith("~\\"))
  ) {
    target = path.join(os.homedir(), target.slice(2));
  }
  return path.resolve(cwd, target);
}

/** `filePath` relative to `dir`, or undefined when it is not inside `dir`. */
function relativeInside(dir: string, filePath: string) {
  const relative = path.relative(dir, filePath);
  if (relative === "" || path.isAbsolute(relative)) return undefined;
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) return undefined;
  return relative;
}

export function createRunChangeTracker() {
  const changed = new Map<string, Set<string>>();

  return {
    /**
     * Record a successful `edit` / `write` of the absolute `filePath` against
     * every running command whose working directory contains it. Edits
     * elsewhere are rarely about the command and would bury the path that is.
     * `terminals` is the manager's full list; ids no longer in it are
     * forgotten, which bounds memory by the manager's history.
     */
    record(filePath: string, terminals: readonly TerminalSnapshot[]) {
      const tracked = new Set(terminals.map((snap) => snap.id));
      for (const id of changed.keys()) {
        if (!tracked.has(id)) changed.delete(id);
      }
      for (const snap of terminals) {
        if (snap.status !== "running") continue;
        const relative = relativeInside(path.resolve(snap.cwd), filePath);
        if (relative === undefined) continue;
        const files = changed.get(snap.id) ?? new Set<string>();
        files.add(relative);
        changed.set(snap.id, files);
      }
    },
    /** Files changed while the terminal ran, relative to its cwd, sorted. */
    changedDuring(id: string) {
      return [...(changed.get(id) ?? [])].sort();
    },
    clear() {
      changed.clear();
    },
  };
}
