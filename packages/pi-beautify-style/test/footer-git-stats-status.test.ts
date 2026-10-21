import assert from "node:assert/strict";
import test from "node:test";
import { readGitStats } from "../extensions/feature/shell/git-stats.ts";
import { repository } from "./helpers/git-repo.ts";

test("ahead/behind counts come from the upstream header without fetching", async (t) => {
	const { cwd, git, write, commit } = repository(t);
	git("switch", "-c", "feature");
	write("feature.txt", "one\n");
	commit();
	const base = git("rev-parse", "HEAD");
	git("switch", "-c", "side", base);
	write("side.txt", "other side\n");
	commit();
	git("switch", "feature");
	write("local.txt", "local\n");
	commit();
	git("update-ref", "refs/remotes/origin/feature", "side");
	git("remote", "add", "origin", "https://example.invalid/repo.git");
	git("config", "branch.feature.remote", "origin");
	git("config", "branch.feature.merge", "refs/heads/feature");
	assert.deepEqual(await readGitStats(cwd, "working"), { add: 0, del: 0, status: "⇡1⇣1" });
});

test("conflicted merge surfaces as = alongside counts", async (t) => {
	const { cwd, git, write, commit } = repository(t);
	git("switch", "-c", "feature");
	write("source.txt", "feature side\n");
	commit();
	git("switch", "main");
	write("source.txt", "main side\n");
	commit();
	try {
		git("merge", "feature");
	} catch {
		// 冲突是预期结果；execFileSync 以退出码 1 抛错
	}
	assert.equal((await readGitStats(cwd, "working"))?.status, "=!");
});
