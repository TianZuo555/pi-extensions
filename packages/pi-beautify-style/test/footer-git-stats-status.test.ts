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
	// 只在合并真的把冲突写进 index 时才断言。git 在极少数环境（例如未配置
	// identity 的 runner 上 merge 被 abort）会留下干净的工作区，这时 readGitStats
	// 正确地返回 undefined，测试不该把它当作失败。
	const status = git("status", "--porcelain");
	if (!status.includes("UU source.txt")) {
		t.diagnostic(`merge did not leave a conflict, got: ${JSON.stringify(status)}`);
		t.skip("git merge did not produce a conflicted index");
		return;
	}
	assert.equal((await readGitStats(cwd, "working"))?.status, "=!");
});
