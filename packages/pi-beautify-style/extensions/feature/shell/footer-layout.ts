/**
 * 自定义 footer 的三行布局。
 *
 * 行是固定的，不提供配置面板，也没有运行时 JSON：
 * - 第一行：内置统计芯片（模型、上下文、缓存、速率、费用）
 * - 第二行：位置（cwd、session 名、分支）
 * - 第三行：其它扩展 `setStatus()` 的文字，pi-usage 也算插件芯片
 *
 * 插件芯片多的时候全挤在第三行，前两行保持稳定，不会随插件增减而换行。
 */

export const PI_USAGE_KEY = "pi-usage";
export const PI_USAGE_SOURCE = "@narumitw/pi-usage";
/**
 * 本仓库的 `@tian.zuo/pi-usage` 用自己的 `setStatus("usage")` 发布额度文本。
 * 上游只认 `pi-usage`，不把 `usage` 别名过来的话芯片会一直空着。
 */
export const LOCAL_USAGE_STATUS_KEY = "usage";

/** 内置芯片。不是 setStatus key，由本扩展自己画。 */
export const FOOTER_MODEL_KEY = "model";
export const FOOTER_CONTEXT_KEY = "context";
export const FOOTER_CACHE_KEY = "cache";
export const FOOTER_RATE_KEY = "rate";
export const FOOTER_COST_KEY = "cost";
export const FOOTER_CWD_KEY = "cwd";
export const FOOTER_GIT_KEY = "git";

/** 第一行的内置统计芯片，顺序与改成三行布局之前一致。 */
export const FOOTER_LINE1_KEYS = [
	FOOTER_MODEL_KEY,
	FOOTER_CONTEXT_KEY,
	FOOTER_CACHE_KEY,
	FOOTER_RATE_KEY,
	FOOTER_COST_KEY,
] as const;

/** 第二行的位置芯片。cwd 在前，git 在后。 */
export const FOOTER_LINE2_KEYS = [FOOTER_CWD_KEY, FOOTER_GIT_KEY] as const;

const BUILTIN_FOOTER_KEYS = new Set<string>([...FOOTER_LINE1_KEYS, ...FOOTER_LINE2_KEYS]);

export function isBuiltinFooterKey(key: string): boolean {
	return BUILTIN_FOOTER_KEYS.has(key);
}

/** 别的扩展写的 model 状态与本扩展的模型芯片重名，不当插件芯片接纳。 */
export function isSkippedFooterStatusKey(key: string): boolean {
	return key === FOOTER_MODEL_KEY;
}

/**
 * 第三行的插件芯片 key：剔除内置项和重名的 model 状态，按 key 字母序，
 * 只留当前有文案的。顺序稳定，不会随 status 更新乱跳。
 */
export function footerLine3Keys(
	hiddenKeys: readonly string[],
	texts: ReadonlyMap<string, string>,
): string[] {
	const hidden = new Set(hiddenKeys);
	return [...texts.keys()]
		.filter((key) => key && !hidden.has(key) && !isBuiltinFooterKey(key))
		.filter((key) => !isSkippedFooterStatusKey(key))
		.filter((key) => (texts.get(key) ?? "").replace(/[\r\n\t]+/g, " ").trim() !== "")
		.sort((a, b) => a.localeCompare(b));
}

/** 按给定 key 顺序收集可见、且当前有文案的插件芯片文本。 */
export function visibleFooterPluginTexts(
	lineKeys: readonly string[],
	texts: ReadonlyMap<string, string>,
): string[] {
	const out: string[] = [];
	for (const key of lineKeys) {
		const text = texts
			.get(key)
			?.replace(/[\r\n\t]+/g, " ")
			.trim();
		if (text) out.push(text);
	}
	return out;
}
