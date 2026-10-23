/**
 * 内置 MCP 的状态栏芯片。
 *
 * pi 的内置 MCP 不写 setStatus：连接状态只在 `/mcp` 菜单里，扩展读不到。这里用公开数据推算
 * 「已连接/已配置」，并在别的扩展接管 `/mcp` 时让位（pi-mcp-adapter 这类扩展自己会写 "mcp" 状态）。
 *
 * - 已连接：`pi.getAllTools()` 里来源是 builtin:mcp、曝光非 hidden 的工具，按 namespace 去重。
 *   断线后工具仍在、0 个工具的服务器连上也看不见，needs-auth / failed 与 connecting 也分不开，
 *   所以这只是近似值。
 * - 已配置：mcp.json 里 enabled !== false 的条目（项目级要已 trust）。
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 与 pi-mcp-adapter 共用同一个 status key；它写了 key 时本扩展不画。 */
export const MCP_STATUS_KEY = "mcp";
/** 内置 MCP 扩展的资源路径。 */
export const BUILTIN_MCP_SOURCE = "builtin:mcp";
const MCP_NAMESPACE_PREFIX = "mcp__";

type McpConfigCacheEntry = { mtimeMs: number; names: string[] };

const configCache = new Map<string, McpConfigCacheEntry>();

export function mcpAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** pi 把 `-` 与 `_` 视作同一个服务器名（`mcpNamespace` 只把 `-` 换成 `_`）。 */
export function normalizeMcpServerName(name: string): string {
	return name.trim().replace(/-/g, "_");
}

/** `mcp__<server>` → `<server>`；不是 MCP 命名空间返回 undefined。 */
export function mcpNamespaceServer(namespace: string): string | undefined {
	if (!namespace.startsWith(MCP_NAMESPACE_PREFIX)) return undefined;
	const server = namespace.slice(MCP_NAMESPACE_PREFIX.length);
	return server || undefined;
}

/** 已连接的服务器名（按 namespace 去重，返回规范化名字）。 */
export function connectedMcpServers(tools: readonly any[]): string[] {
	const fromBuiltin = new Set<string>();
	const fromNamespace = new Set<string>();
	for (const tool of tools ?? []) {
		if (tool?.exposure === "hidden") continue;
		const server = mcpNamespaceServer(String(tool?.namespace?.name ?? ""));
		if (!server) continue;
		const name = normalizeMcpServerName(server);
		if (tool?.sourceInfo?.path === BUILTIN_MCP_SOURCE) fromBuiltin.add(name);
		else fromNamespace.add(name);
	}
	// 版本漂移兜底：来源路径对不上时按 namespace 认（接管 /mcp 的扩展已在此之前排除）
	return [...(fromBuiltin.size > 0 ? fromBuiltin : fromNamespace)];
}

/** `MCP 2/3`：已连接/（已连接 ∪ 已配置）。两边都空时不显示。 */
export function formatMcpChip(
	connected: readonly string[],
	configured: readonly string[],
): string | undefined {
	const connectedNames = new Set(connected.map(normalizeMcpServerName).filter(Boolean));
	const configuredNames = new Set(configured.map(normalizeMcpServerName).filter(Boolean));
	const total = new Set([...connectedNames, ...configuredNames]).size;
	if (total === 0) return undefined;
	return `MCP ${connectedNames.size}/${total}`;
}

/** 读一个 mcp.json 里启用中的服务器名；文件缺失或损坏返回 undefined。 */
function readMcpConfigNames(path: string): string[] | undefined {
	try {
		const { mtimeMs } = statSync(path);
		const cached = configCache.get(path);
		if (cached && cached.mtimeMs === mtimeMs) return cached.names;
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: unknown };
		const servers = parsed?.mcpServers;
		const names: string[] = [];
		if (servers && typeof servers === "object" && !Array.isArray(servers)) {
			for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
				if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
				if ((entry as { enabled?: unknown }).enabled === false) continue;
				names.push(name);
			}
		}
		configCache.set(path, { mtimeMs, names });
		return names;
	} catch {
		configCache.delete(path);
		return undefined;
	}
}

/** mcp.json 里启用中的服务器名：用户级，加上已信任时的项目级（同名以项目为准，计数时去重）。 */
export function configuredMcpServers(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
}): string[] {
	const names = [...(readMcpConfigNames(join(options.agentDir, "mcp.json")) ?? [])];
	if (options.projectTrusted) {
		names.push(...(readMcpConfigNames(join(options.cwd, ".pi", "mcp.json")) ?? []));
	}
	return names;
}

/** 注册了 `/mcp` 的都是内置 MCP；别的扩展接管时它自己会写状态芯片。 */
export function builtinMcpOwnsCommand(commands: readonly any[]): boolean {
	const mcpCommands = (commands ?? []).filter((command) => command?.name === MCP_STATUS_KEY);
	return (
		mcpCommands.length > 0 &&
		mcpCommands.every((command) => command?.sourceInfo?.path === BUILTIN_MCP_SOURCE)
	);
}

/** footer 渲染用：当前芯片文案（不含 nerd 图标），不适用时返回 undefined。 */
export function buildMcpChip(ctx: any, api: any): string | undefined {
	try {
		// 工具与命令列表在 pi API 上，ctx 只提供 cwd / trust
		if (!builtinMcpOwnsCommand(api?.getCommands?.() ?? [])) return undefined;
		const tools = api?.getAllTools?.();
		if (!Array.isArray(tools)) return undefined;
		return formatMcpChip(
			connectedMcpServers(tools),
			configuredMcpServers({
				agentDir: mcpAgentDir(),
				cwd: String(ctx?.cwd ?? process.cwd()),
				projectTrusted: ctx?.isProjectTrusted?.() === true,
			}),
		);
	} catch {
		// footer 不能因为读配置或读工具列表失败而中断渲染
		return undefined;
	}
}
