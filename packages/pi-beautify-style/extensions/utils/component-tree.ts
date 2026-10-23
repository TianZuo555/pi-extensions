/**
 * 组件树递归遍历共享实现。
 *
 * 收敛原先散落在 renderer 的 compact-mode / message-display / transcript-refresh /
 * grouping / mouse/packets 的「children + getMountedRoots + seen 防环」同款遍历。
 *
 * visitor 在每个非数组对象节点上调用一次；返回 `false` 表示不再下钻该节点的
 * children 与 mounted roots（对应各处原有的提前 return 语义）。
 */
export function walkComponentTree(root: any, visitor: (value: any) => boolean | void): void {
	const seen = new Set<any>();
	const visit = (value: any): void => {
		if (!value || typeof value !== "object" || seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const child of value) visit(child);
			return;
		}
		if (visitor(value) === false) return;
		const children = value.children;
		if (Array.isArray(children)) {
			for (const child of children) visit(child);
		}
		try {
			const mounted = value.getMountedRoots?.();
			if (Array.isArray(mounted)) {
				for (const root of mounted) visit(root);
			}
		} catch {
			// renderer 切换中的惰性 Proxy 可能暂时没有 mounted roots。
		}
	};
	visit(root);
}
