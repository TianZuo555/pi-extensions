import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type test from "node:test";

// 建一个共享模板仓库（含初始 commit），每个测试 git clone --local 复制。
// Clone ~180ms，而 init + 5 次 config + commit 需要 ~580ms；14 个测试累计省 ~5s。
// 模板在模块加载时创建，不能用 t.after 绑定（会在首个 test 结束时被删）。
const templateRepo = (() => {
	const dir = mkdtempSync(join(tmpdir(), "pi-footer-git-tpl-"));
	process.on("exit", () => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// 清理失败不影响测试退出
		}
	});
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: dir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	git("init", "--template=", "--initial-branch=main");
	git("config", "user.name", "Footer Test");
	git("config", "user.email", "footer@example.invalid");
	git("config", "commit.gpgsign", "false");
	git("config", "core.autocrlf", "false");
	git("config", "core.hooksPath", join(dir, "no-hooks"));
	writeFileSync(join(dir, "source.txt"), "one\ntwo\nthree\n");
	git("add", ".");
	git("commit", "--quiet", "-m", "fixture");
	return dir;
})();

export function repository(t: test.TestContext, initialBranch = "main") {
	const tpl = templateRepo;
	// git clone 要求目标不存在；mkdtempSync 创建后先 rm，保留后续清理逻辑。
	const cwd = mkdtempSync(join(tmpdir(), "pi-footer-git-"));
	rmSync(cwd, { recursive: true, force: true });
	t.after(async () => {
		// Windows：abort 杀掉的 git 子进程句柄释放有延迟，rmSync 偊发 EPERM，重试几次
		for (let attempt = 0; ; attempt++) {
			try {
				rmSync(cwd, { recursive: true, force: true });
				return;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY")) throw error;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
	});
	// clone 比 init+config+commit 快 ~3x，模板已带 source.txt 和首个 commit。
	execFileSync("git", ["clone", "--quiet", "--local", "--no-hardlinks", tpl, cwd], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	// clone 会加 origin 和 branch tracking；测试要自己控制 remote，先删 remote 顺便清 tracking。
	if (initialBranch !== "main") {
		git("branch", "-m", "main", initialBranch);
	}
	git("remote", "remove", "origin");
	const write = (name: string, content: string) => writeFileSync(join(cwd, name), content);
	const commit = () => {
		git("add", ".");
		git("commit", "--quiet", "-m", "fixture");
	};
	return { cwd, git, write, commit };
}
