import assert from "node:assert/strict";
import test from "node:test";
import { readGitStats } from "../extensions/feature/shell/git-stats.ts";
import { repository } from "./helpers/git-repo.ts";

test("branch includes committed new files and uncommitted edits, and remains stable across commit", async (t) => {
	const { cwd, git, write, commit } = repository(t);
	git("switch", "-c", "feature");
	write("source.txt", "one\nchanged\nthree\n");
	write("committed-test.txt", "test one\ntest two\n");
	commit();
	assert.deepEqual(await readGitStats(cwd, "working"), { add: 0, del: 0 });
	assert.deepEqual(await readGitStats(cwd, "branch"), { add: 3, del: 1 });
	write("source.txt", "one\nchanged\nthree\nextra\n");
	write("staged.txt", "staged line\n");
	git("add", "staged.txt");
	write("untracked.txt", "excluded\n");
	assert.deepEqual(await readGitStats(cwd, "branch"), { add: 5, del: 1, status: "!?" });
	git("add", "source.txt");
	git("commit", "-m", "commit tracked edits");
	assert.deepEqual(await readGitStats(cwd, "branch"), { add: 5, del: 1, status: "?" });
});

test("branch counts net changes, not summed commits, and uses the merge base rather than base tip", async (t) => {
	const { cwd, git, write, commit } = repository(t);
	git("switch", "-c", "feature");
	write("source.txt", "one\nchanged\nthree\n");
	commit();
	write("source.txt", "one\ntwo\nthree\n");
	commit();
	git("switch", "main");
	write("main-only.txt", "unrelated main change\n");
	commit();
	git("switch", "feature");
	assert.deepEqual(await readGitStats(cwd, "branch"), { add: 0, del: 0 });
});

test("unrelated base histories hide branch stats", async (t) => {
	const { cwd, git, write, commit } = repository(t);
	git("switch", "--orphan", "feature");
	write("orphan.txt", "new history\n");
	commit();
	assert.equal(await readGitStats(cwd, "branch"), undefined);
});
