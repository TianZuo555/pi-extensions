import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { config } from "../extensions/config/config.ts";
import { applyPromptEditor, clearPromptEditor } from "../extensions/feature/shell/prompt-editor.ts";

type EditorFactory = (tui: unknown, theme: unknown, keybindings: unknown) => unknown;

/** Minimal UI stub: one editor slot plus a notification sink. */
function fakeEditorSlot() {
	let factory: EditorFactory | undefined;
	return {
		ui: {
			getEditorComponent: () => factory,
			setEditorComponent: (next: EditorFactory | undefined) => {
				factory = next;
			},
			notify: () => {},
		},
		get factory() {
			return factory;
		},
		set factory(next: EditorFactory | undefined) {
			factory = next;
		},
	};
}

function useEditorPrefix(t: { after: (fn: () => void) => void }, enabled: boolean): void {
	const previous = config.enableEditorPrefix;
	t.after(() => {
		config.enableEditorPrefix = previous;
	});
	config.enableEditorPrefix = enabled;
}

test("restores the editor it replaced", (t) => {
	useEditorPrefix(t, true);
	const other: EditorFactory = () => ({});
	const slot = fakeEditorSlot();
	slot.factory = other;
	const ctx = { hasUI: true, ui: slot.ui } as unknown as ExtensionContext;

	applyPromptEditor(ctx);
	assert.notEqual(slot.factory, other);

	clearPromptEditor(ctx);
	assert.equal(slot.factory, other);
});

test("disabled prefix leaves another extension's editor alone", (t) => {
	useEditorPrefix(t, false);
	const other: EditorFactory = () => ({});
	const slot = fakeEditorSlot();
	slot.factory = other;
	const ctx = { hasUI: true, ui: slot.ui } as unknown as ExtensionContext;

	applyPromptEditor(ctx);
	assert.equal(slot.factory, other);

	// Never occupied the slot: clearing must not touch it either.
	clearPromptEditor(ctx);
	assert.equal(slot.factory, other);
});
