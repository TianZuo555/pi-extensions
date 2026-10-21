const UNSAFE_TERMINAL_ESCAPE = new RegExp(
	"(?:\\u001B\\]|\\u009D)[\\s\\S]*?(?:\\u0007|\\u001B\\x5C|\\u009C)" +
		"|(?:\\u001B[PX^_]|\\u0090)[\\s\\S]*?(?:\\u001B\\x5C|\\u009C)" +
		"|(?:\\u001B\\[|\\u009B)[0-?]*[ -/]*[@-~]" +
		"|\\u001B[@-_]",
	"g",
);

/**
 * Prevent captured terminal control responses from being replayed by tool renderers.
 * Optional `maxChars` trims the input first so preview/one-line paths never scan multi-MB outputs.
 */
export function sanitizeToolResultText(value: string, maxChars?: number): string {
	const source =
		typeof maxChars === "number" && maxChars >= 0 && value.length > maxChars
			? value.slice(0, maxChars)
			: value;
	return source
		.replace(UNSAFE_TERMINAL_ESCAPE, "")
		.replace(/\x1B/g, "")
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
}
