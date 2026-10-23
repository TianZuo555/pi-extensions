import assert from "node:assert/strict";
import test from "node:test";
import { readGitStats } from "../extensions/feature/shell/git-stats.ts";
import { repository } from "./helpers/git-repo.ts";

test("origin/HEAD takes priority over local main, never the feature upstream", async (t) => {
	const { cwd, git, write, commit } = repository(t);
	git("switch", "-c", "feature");
	write("feature.txt", "first\n");
	commit();
	git("update-ref", "refs/remotes/origin/develop", "HEAD");
	git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
	write("feature.txt", "first\nsecond\n");
	commit();
	git("remote", "add", "origin", "https://example.invalid/repo.git");
	git("update-ref", "refs/remotes/origin/feature", "HEAD");
	git("config", "branch.feature.remote", "origin");
	git("config", "branch.feature.merge", "refs/heads/feature");
	assert.deepEqual(await readGitStats(cwd, "branch"), { add: 1, del: 0 });
	// Re-resolve refs every time; advancing remote HEAD must not use a cached base.
	git("update-ref", "refs/remotes/origin/develop", "HEAD");
	assert.deepEqual(await readGitStats(cwd, "branch"), { add: 0, del: 0 });
});

test("dangling origin/HEAD falls back to local main, then master", async (t) => {
	const { cwd, git, write, commit } = repository(t, "master");
	git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/missing");
	git("switch", "-c", "feature");
	write("new.txt", "new\n");
	commit();
	assert.deepEqual(await readGitStats(cwd, "branch"), { add: 1, del: 0 });
	git("branch", "main", "HEAD");
	assert.deepEqual(await readGitStats(cwd, "branch"), { add: 0, del: 0 });
});
