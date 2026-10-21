import assert from "node:assert/strict";
import test from "node:test";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { installFlushDockedBash } from "../extensions/feature/shell/flush-docked-bash.ts";

test("handleBashCommand 结束后立刻 flush pending bash", async () => {
	const proto = InteractiveMode.prototype as any;
	const real = proto.handleBashCommand;
	proto.handleBashCommand = async function (this: any) {
		this.ran = true;
	};
	try {
		installFlushDockedBash();
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
		proto.handleBashCommand = real;
	}
});
