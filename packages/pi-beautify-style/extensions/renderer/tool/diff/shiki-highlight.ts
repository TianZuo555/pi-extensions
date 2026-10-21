export const MAX_HL_CHARS = 32_000;
const MAX_CACHE_ENTRIES = 48;

type CodeToAnsi = (code: string, lang: any, theme: any) => Promise<string>;
type Loader = () => Promise<CodeToAnsi>;
type Subscriber = { fallback: readonly string[]; invalidate: () => void };
type Pending = { work: Promise<void>; subscribers: Set<Subscriber> };

let defaultLoad: Promise<CodeToAnsi> | undefined;
const loadDefault: Loader = () => {
	if (!defaultLoad) {
		defaultLoad = import("@shikijs/cli")
			.then((module) => module.codeToANSI as CodeToAnsi)
			.catch((error) => {
				defaultLoad = undefined;
				throw error;
			});
	}
	return defaultLoad;
};

function differs(lines: readonly string[], fallback: readonly string[]): boolean {
	return lines.length !== fallback.length || lines.some((line, index) => line !== fallback[index]);
}

export class ShikiHighlightCache {
	private readonly cache = new Map<string, string[]>();
	private readonly pending = new Map<string, Pending>();
	private readonly loader: Loader;

	constructor(loader: Loader = loadDefault) {
		this.loader = loader;
	}

	get(
		code: string,
		lang: string | undefined,
		theme: string,
		fallback: readonly string[],
		invalidate?: () => void,
	): string[] | undefined {
		if (!lang || code.length > MAX_HL_CHARS) return undefined;
		const key = `${theme}\0${lang}\0${code}`;
		const cached = this.cache.get(key);
		if (cached) {
			this.cache.delete(key);
			this.cache.set(key, cached);
			return cached;
		}

		const existing = this.pending.get(key);
		if (existing) {
			if (invalidate && ![...existing.subscribers].some((item) => item.invalidate === invalidate)) {
				existing.subscribers.add({ fallback, invalidate });
			}
			return undefined;
		}

		const pending: Pending = { work: undefined as never, subscribers: new Set() };
		if (invalidate) pending.subscribers.add({ fallback, invalidate });
		pending.work = this.loader()
			.then((highlight) => highlight(code, lang, theme))
			.then((ansi) => {
				const lines = ansi.replace(/\r/g, "").replace(/\n$/, "").split("\n");
				this.cache.set(key, lines);
				while (this.cache.size > MAX_CACHE_ENTRIES) {
					const oldest = this.cache.keys().next().value;
					if (oldest !== undefined) this.cache.delete(oldest);
				}
				for (const subscriber of pending.subscribers) {
					if (!differs(lines, subscriber.fallback)) continue;
					try {
						subscriber.invalidate();
					} catch {
						// One component must not prevent the other subscribers from repainting.
					}
				}
			})
			.catch(() => {})
			.finally(() => this.pending.delete(key));
		this.pending.set(key, pending);
		return undefined;
	}

	clear(): void {
		this.cache.clear();
	}
}

export const shikiHighlightCache = new ShikiHighlightCache();
