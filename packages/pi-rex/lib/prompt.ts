// Model-facing text for pi-rex. Keep every prompt string here, apart from the
// runtime that injects it.

/** System prompt section name. */
export const REX_SECTION = "rex";

/**
 * Appended to the Rex session-start output when `rex.renameTab` is true.
 *
 * A session is the parent and a tab is the child: the first tab carries the
 * session label, later tabs get their own label.
 */
export const TAB_RENAME_INSTRUCTION = `Name the tab (window) too. Do it in the same step as the session rename. Do not wait for the user to ask.

A Rex session is the parent and a tab is the child. The first tab of a session takes the session label. A later tab gets its own label.

1. Run \`rex whoami --json\` and read \`.window_id\`.
2. Run \`rex window ls -s "$REX_SESSION" --json\` and sort the window IDs.
3. If your window ID is the first ID, use the session label. If not, choose a label for the work in this tab. Use two to four lowercase words joined by hyphens.
4. Rename with \`rex window rename -s "$REX_SESSION" WINDOW_ID LABEL\`.
5. Keep a label that already fits the work. If the rename fails, continue the task and do not mention it.`;
