import assert from "node:assert/strict";
import test from "node:test";
import {
	config,
	normalizeConfig,
	setConfig,
	type FooterGitStatsMode,
} from "../extensions/config/config.ts";
import { applyCustomFooter, refreshFooterGitStats } from "../extensions/feature/shell/footer.ts";
import { createGitStatsRefresher, type GitStats } from "../extensions/feature/shell/git-stats.ts";
import { repository } from "./helpers/git-repo.ts";

test("active footer switches working → branch → working without recreation or reload", async (t) => {
	const { cwd, git, write, commit } = repository(t);
	git("switch", "-c", "feature");
	write("committed.txt", "first\nsecond\n");
	commit();
	write("source.txt", "one\nchanged\nthree\n");
	const previous = { ...config };
	setConfig(normalizeConfig({ footerGitStatsMode: "working", footerNerdIcons: false }));
	t.after(() => setConfig(previous));
	let footer!: { render: (width: number) => string[]; dispose: () => void };
	let factoryCalls = 0;
	let branchChanged!: () => void;
	let unsubscribed = false;
	const ctx = {
		cwd,
		hasUI: true,
		getContextUsage: () => undefined,
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getSessionName: () => undefined,
		},
		ui: {
			setFooter: (factory: (tui: unknown, theme: unknown, data: unknown) => typeof footer) => {
				factoryCalls++;
				footer = factory(
					{ requestRender: () => {} },
					{
						fg: (_color: string, text: string) => text,
						getThinkingBorderColor: () => (text: string) => text,
					},
					{
						getGitBranch: () => "feature",
						getExtensionStatuses: () => new Map(),
						onBranchChange: (callback: () => void) => {
							branchChanged = callback;
							return () => {
								unsubscribed = true;
							};
						},
					},
				);
			},
		},
	};
	applyCustomFooter(ctx as never);
	t.after(() => footer.dispose());
	const line = () => footer.render(200)[1];
	const waitForStats = async (stats: string) => {
		const deadline = Date.now() + 5000;
		while (!line().includes(stats)) {
			assert.ok(Date.now() < deadline, `Expected ${stats}, got ${line()}`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	await waitForStats("[!](+1 −1)");
	setConfig(normalizeConfig({ ...config, footerGitStatsMode: "branch" }));
	refreshFooterGitStats();
	assert.doesNotMatch(line(), /\(\+/);
	await waitForStats("[!](+3 −1)");
	setConfig(normalizeConfig({ ...config, footerGitStatsMode: "working" }));
	refreshFooterGitStats();
	await waitForStats("[!](+1 −1)");
	assert.equal(factoryCalls, 1);
	// A branch change must drop old numbers even if the mode stays the same.
	write("source.txt", "one\ntwo\nthree\n");
	git("switch", "main");
	branchChanged();
	assert.doesNotMatch(line(), /\(\+/);
	footer.dispose();
	assert.equal(unsubscribed, true);
});

function deferred() {
	let resolve!: (stats: GitStats | undefined) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<GitStats | undefined>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function refresherFixture(t: test.TestContext) {
	let mode: FooterGitStatsMode = "working";
	const requests: Array<
		ReturnType<typeof deferred> & { mode: FooterGitStatsMode; signal: AbortSignal }
	> = [];
	const updates: Array<GitStats | undefined> = [];
	const refresher = createGitStatsRefresher({
		getMode: () => mode,
		query: (requestedMode, signal) => {
			const request = { ...deferred(), mode: requestedMode, signal };
			requests.push(request);
			return request.promise;
		},
		onChange: (stats) => updates.push(stats),
	});
	t.after(() => refresher.dispose());
	return { ...refresher, requests, updates, setMode: (next: FooterGitStatsMode) => (mode = next) };
}

test("mode changes clear old stats immediately and discard in-flight results", async (t) => {
	const f = refresherFixture(t);
	f.refresh();
	f.requests[0].resolve({ add: 15, del: 9 });
	await tick();
	f.refresh();
	f.setMode("branch");
	f.refresh(true);
	assert.deepEqual(f.updates, [{ add: 15, del: 9 }, undefined]);
	assert.equal(f.requests.length, 2);
	f.requests[1].resolve({ add: 16, del: 9 });
	await tick();
	assert.equal(f.requests[2].mode, "branch");
	assert.deepEqual(f.updates, [{ add: 15, del: 9 }, undefined]);
	f.requests[2].resolve({ add: 75, del: 9 });
	await tick();
	assert.deepEqual(f.updates, [{ add: 15, del: 9 }, undefined, { add: 75, del: 9 }]);
});

test("branch resets and overlapping tool refreshes queue just one latest query", async (t) => {
	const f = refresherFixture(t);
	f.refresh();
	f.refresh(true);
	f.refresh();
	f.refresh();
	assert.equal(f.requests.length, 1);
	f.requests[0].resolve({ add: 99, del: 0 });
	await tick();
	assert.equal(f.requests.length, 2);
	assert.deepEqual(f.updates, []);
	f.requests[1].resolve({ add: 1, del: 0 });
	await tick();
	assert.deepEqual(f.updates, [{ add: 1, del: 0 }]);
});

test("unchanged polls avoid repaint, failures clear stats and later queries recover", async (t) => {
	const f = refresherFixture(t);
	f.refresh();
	f.requests[0].resolve({ add: 1, del: 0 });
	await tick();
	f.refresh();
	f.requests[1].resolve({ add: 1, del: 0 });
	await tick();
	assert.equal(f.updates.length, 1);
	f.refresh();
	f.requests[2].reject(new Error("timeout"));
	await tick();
	assert.deepEqual(f.updates, [{ add: 1, del: 0 }, undefined]);
	f.refresh();
	f.requests[3].resolve(undefined);
	await tick();
	assert.equal(f.updates.length, 2);
	f.refresh();
	f.requests[4].resolve({ add: 2, del: 1 });
	await tick();
	assert.deepEqual(f.updates.at(-1), { add: 2, del: 1 });
});

test("disposed footers neither publish nor start queued queries", async (t) => {
	const f = refresherFixture(t);
	f.refresh();
	f.refresh();
	f.dispose();
	assert.equal(f.requests[0].signal.aborted, true);
	f.dispose();
	f.requests[0].resolve({ add: 1, del: 0 });
	await tick();
	f.refresh();
	assert.equal(f.requests.length, 1);
	assert.deepEqual(f.updates, []);
});
