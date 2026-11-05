import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorktrees, sessionLabel, type GitExec } from "../lib/session-name.ts";

const MAIN = "/Users/me/Workspace/pi-tian-extensions";
const WORKTREE = "/Users/me/Workspace/pi-layerfs-spec";

const LIST = `worktree ${MAIN}
HEAD 1111111
branch refs/heads/main

worktree ${WORKTREE}
HEAD 2222222
branch refs/heads/docs/pi-layerfs-spec

`;

const git =
  (stdout: string, code = 0): GitExec =>
  async () => ({ code, stdout });

test("parses one entry per worktree", () => {
  assert.deepEqual(parseWorktrees(LIST), [
    { path: MAIN, head: "1111111", branch: "refs/heads/main" },
    { path: WORKTREE, head: "2222222", branch: "refs/heads/docs/pi-layerfs-spec" },
  ]);
});

test("uses the folder name in a main checkout", async () => {
  assert.equal(await sessionLabel(git(LIST), MAIN, 5000), "pi-tian-extensions");
});

test("uses the current folder name in a subdirectory of a main checkout", async () => {
  assert.equal(await sessionLabel(git(LIST), `${MAIN}/src`, 5000), "src");
});

test("uses the worktree label in a linked worktree", async () => {
  assert.equal(
    await sessionLabel(git(LIST), WORKTREE, 5000),
    "Wrktree—pi-tian-extensions—docs/pi-layerfs-spec",
  );
});

test("uses the worktree label in a subdirectory of a linked worktree", async () => {
  assert.equal(
    await sessionLabel(git(LIST), `${WORKTREE}/packages/pi-rex`, 5000),
    "Wrktree—pi-tian-extensions—docs/pi-layerfs-spec",
  );
});

test("uses the short commit for a detached worktree", async () => {
  const detached = `worktree ${MAIN}
HEAD 1111111
branch refs/heads/main

worktree ${WORKTREE}
HEAD 69f9f0e1234567
detached
`;
  assert.equal(
    await sessionLabel(git(detached), WORKTREE, 5000),
    "Wrktree—pi-tian-extensions—69f9f0e",
  );
});

test("uses the folder name when git fails", async () => {
  assert.equal(await sessionLabel(git("", 1), WORKTREE, 5000), "pi-layerfs-spec");
  assert.equal(
    await sessionLabel(
      async () => {
        throw new Error("git missing");
      },
      WORKTREE,
      5000,
    ),
    "pi-layerfs-spec",
  );
});

test("uses the folder name when the directory is in no listed worktree", async () => {
  assert.equal(await sessionLabel(git(LIST), "/Users/me/elsewhere", 5000), "elsewhere");
});
