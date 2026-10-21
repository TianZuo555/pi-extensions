/**
 * fullscreen 下 ! / !! 在 agent 仍 streaming 时挂到 dock（pendingMessages）。
 * 官方只在下次普通 submit 才 flushPendingBashComponents，命令结束后卡钉在输入框上方。
 * 在 handleBashCommand 收尾补一次 flush。
 */
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { FLUSH_DOCKED_BASH_PATCH, patchRegistry } from "../../utils/patch-keys.ts";

type Patch = {
	active: boolean;
	prototype: any;
	original: (...args: any[]) => unknown;
	installed: (...args: any[]) => unknown;
};

export function installFlushDockedBash(): void {
	const prototype = InteractiveMode.prototype as any;
	const previous = patchRegistry.get<Patch>(FLUSH_DOCKED_BASH_PATCH);
	if (previous) previous.active = false;
	const original =
		previous && prototype.handleBashCommand === previous.installed
			? previous.original
			: prototype.handleBashCommand;
	const patch: Patch = {
		active: true,
		prototype,
		original,
		installed: async function (this: any, ...args: any[]) {
			const result = await original.apply(this, args);
			if (patch.active) this.flushPendingBashComponents();
			return result;
		},
	};
	prototype.handleBashCommand = patch.installed;
	patchRegistry.install(FLUSH_DOCKED_BASH_PATCH, patch);
}
