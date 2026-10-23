import assert from "node:assert/strict";
import test from "node:test";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import {
	installFlushDockedBash,
	registerFlushDockedBash,
} from "../extensions/feature/shell/flush-docked-bash.ts";
import { FLUSH_DOCKED_BASH_PATCH, patchRegistry } from "../extensions/utils/patch-keys.ts";

test("handleBashCommand 结束后立刻 flush pending bash", async () => {
	const proto = InteractiveMode.prototype as any;
	const real = proto.handleBashCommand;
	proto.handleBashCommand = async function (this: any) {
		this.ran = true;
	};
	const dispose = installFlushDockedBash();
	try {
		const ctx = {
			ran: false,
			flushed: 0,
			flushPendingBashComponents() {
				this.flushed++;
			},
		};
		await proto.handleBashCommand.call(ctx);
		assert.equal(ctx.ran, true);
		assert.equal(ctx.flushed, 1);
	} finally {
		dispose();
		proto.handleBashCommand = real;
	}
});

test("docked bash patches follow interactive session ownership", async () => {
	const prototype = InteractiveMode.prototype as any;
	const original = prototype.handleBashCommand;
	const runtime = () => {
		const events = new Map<string, Function>();
		registerFlushDockedBash({
			on: (name: string, handler: Function) => events.set(name, handler),
		} as any);
		return {
			start: (ctx: any) => events.get("session_start")!({}, ctx),
			stop: () => events.get("session_shutdown")!(),
		};
	};
	const first = runtime();
	const second = runtime();
	const headless = runtime();
	try {
		first.start({ mode: "tui", hasUI: true });
		const firstMethod = prototype.handleBashCommand;
		first.start({ mode: "tui", hasUI: true });
		assert.equal(prototype.handleBashCommand, firstMethod);
		headless.start({ mode: "print", hasUI: false });
		headless.stop();
		assert.equal(prototype.handleBashCommand, firstMethod);
		second.start({ mode: "tui", hasUI: true });
		const secondMethod = prototype.handleBashCommand;
		first.stop();
		assert.equal(prototype.handleBashCommand, secondMethod);
		second.stop();
		assert.equal(prototype.handleBashCommand, original);
		assert.equal(patchRegistry.get(FLUSH_DOCKED_BASH_PATCH), undefined);
		first.start({ mode: "tui", hasUI: true });
		const installed = prototype.handleBashCommand;
		const external = function (this: any, ...args: any[]) {
			return installed.apply(this, args);
		};
		prototype.handleBashCommand = external;
		first.stop();
		assert.equal(prototype.handleBashCommand, external);
		assert.equal(patchRegistry.get(FLUSH_DOCKED_BASH_PATCH), undefined);
	} finally {
		first.stop();
		second.stop();
		headless.stop();
		prototype.handleBashCommand = original;
	}
});
