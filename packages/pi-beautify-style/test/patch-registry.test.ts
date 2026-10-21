import assert from "node:assert/strict";
import test from "node:test";

import { PatchRegistry, patchRegistry } from "../extensions/utils/patch-keys.ts";

test("dispose only deletes when still owned; ensure initializes once", () => {
	const registry = new PatchRegistry({});
	const key = Symbol("dispose");
	const stale = { id: "stale" };
	const current = { id: "current" };

	registry.install(key, stale);
	registry.install(key, current);
	assert.equal(registry.dispose(key, stale), false);
	assert.equal(registry.get(key), current);
	assert.equal(registry.dispose(key, current), true);
	assert.equal(registry.get(key), undefined);

	const ensureKey = Symbol("ensure");
	let inits = 0;
	const first = registry.ensure(ensureKey, () => {
		inits++;
		return { value: inits };
	});
	assert.equal(
		registry.ensure(ensureKey, () => ({ value: 99 })),
		first,
	);
	assert.equal(inits, 1);
});

test("singleton storage is globalThis", () => {
	const key = Symbol.for("pi.ccstyle.test.patch-registry");
	try {
		patchRegistry.install(key, { tag: "via-registry" });
		assert.equal(
			(globalThis as unknown as Record<PropertyKey, { tag: string }>)[key].tag,
			"via-registry",
		);
		(globalThis as Record<PropertyKey, unknown>)[key] = { tag: "via-globalThis" };
		assert.equal(patchRegistry.get<{ tag: string }>(key)?.tag, "via-globalThis");
	} finally {
		patchRegistry.delete(key);
	}
});
