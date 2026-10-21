import { createWriteToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
	renderEditDiffResult,
	renderWriteDiffResult,
	type DisplayConfigInput,
} from "./diff-renderer.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../../../config/config.ts";
import { patchRegistry, WRITE_OWNERSHIP_SLOT } from "../../../utils/patch-keys.ts";
import { executeWriteWithMetadata, WriteExecutionMetadataStore } from "./write-execution.ts";

function resultText(result: any): string {
	const blocks = Array.isArray(result?.content) ? result.content : [];
	return blocks
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("\n");
}

function unavailableComponent(reason: string, theme: any) {
	return {
		render(width: number): string[] {
			return [
				truncateToWidth(
					theme.fg("warning", `↳ diff unavailable: ${reason}`),
					Math.max(0, width),
					"",
				),
			];
		},
		invalidate() {},
	};
}

export function renderRichToolResult(
	toolName: string,
	result: any,
	options: any,
	theme: any,
	context: any,
	writeMetadata: WriteExecutionMetadataStore,
	/** Plain snapshot or live getter — getter lets /ccstyle panel changes repaint existing diffs. */
	displayConfig: DisplayConfigInput = DEFAULT_TOOL_DISPLAY_CONFIG,
): any | undefined {
	if (options?.isPartial || options?.isError || context?.isError) return undefined;
	const expanded = options?.expanded === true || context?.expanded === true;
	const filePath = context?.args?.file_path ?? context?.args?.path;
	if (toolName === "edit") {
		return renderEditDiffResult(
			result?.details,
			{
				expanded,
				filePath,
				isHovered: options?.isHovered,
				invalidate: () => context?.invalidate?.(),
			},
			displayConfig,
			theme,
			resultText(result),
		);
	}
	if (toolName !== "write") return undefined;
	// 让位点：write 归其他扩展时不提供富 diff，交回普通结果行。
	if (!ownsWriteTool()) return undefined;

	const metadata = writeMetadata.get(context?.toolCallId);
	if (!metadata) {
		return unavailableComponent("execution metadata is unavailable", theme);
	}
	if (metadata.diffUnavailableReason) {
		return unavailableComponent(metadata.diffUnavailableReason, theme);
	}
	return renderWriteDiffResult(
		typeof context?.args?.content === "string" ? context.args.content : undefined,
		{
			expanded,
			filePath,
			previousContent: metadata.previousContent,
			fileExistedBeforeWrite: metadata.fileExistedBeforeWrite,
			isHovered: options?.isHovered,
			invalidate: () => context?.invalidate?.(),
		},
		displayConfig,
		theme,
		resultText(result),
	);
}

/** write 被其他扩展占用时的来源，用于提示冲突。 */
export type ExternalWriteOwner = { source: string; path: string };

type WriteOwnershipState = {
	/** write 是否由本插件执行；undefined 表示尚未确认，按拥有处理以保持既有行为。 */
	owned?: boolean;
};

function writeOwnership(): WriteOwnershipState {
	return patchRegistry.ensure<WriteOwnershipState>(WRITE_OWNERSHIP_SLOT, () => ({}));
}

/**
 * write 是否由本插件执行。只有注册过 write override 才有执行元数据，
 * 否则渲染层要放行给普通结果行，避免每张卡降级成 "diff unavailable"。
 */
export function ownsWriteTool(): boolean {
	return writeOwnership().owned !== false;
}

/** 当前占用 write 的其他扩展；builtin 或未注册时返回 undefined。 */
function findExternalWriteOwner(pi: ExtensionAPI): ExternalWriteOwner | undefined {
	try {
		const tools = pi.getAllTools() as any[];
		const write = tools?.find((tool: any) => tool?.name === "write") as any;
		const sourceInfo = write?.sourceInfo;
		const source = sourceInfo?.source;
		if (!write || typeof source !== "string" || source === "builtin") return undefined;
		return { source, path: typeof sourceInfo?.path === "string" ? sourceInfo.path : "" };
	} catch {
		// getAllTools 在扩展运行时绑定前不可用。
		return undefined;
	}
}

export function installWriteOverride(
	pi: ExtensionAPI,
	store = new WriteExecutionMetadataStore(),
	/** write 已被其他扩展占用时回调一次，调用方据此提示冲突。 */
	onExternalOwner?: (owner: ExternalWriteOwner) => void,
): WriteExecutionMetadataStore {
	if (typeof (pi as any).registerTool !== "function") return store;
	const state = writeOwnership();
	const external = findExternalWriteOwner(pi);
	if (external) {
		// 让位：执行与 diff 都归对方，渲染层据 owned=false 走普通结果行。
		state.owned = false;
		onExternalOwner?.(external);
		return store;
	}
	state.owned = true;
	const nativeWrite = createWriteToolDefinition(process.cwd()) as any;
	pi.registerTool({
		...nativeWrite,
		async execute(
			toolCallId: string,
			params: { path: string; content: string },
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: { cwd: string },
		) {
			return executeWriteWithMetadata(store, toolCallId, params, signal, ctx.cwd);
		},
	});
	return store;
}

export {
	DEFAULT_TOOL_DISPLAY_CONFIG,
	type ToolDisplayConfig,
	type DiffViewMode,
	type DiffIndicatorMode,
} from "../../../config/config.ts";
export type { DisplayConfigInput } from "./diff-renderer.ts";
export { WriteExecutionMetadataStore } from "./write-execution.ts";
