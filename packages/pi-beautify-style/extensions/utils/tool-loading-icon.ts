export const TOOL_LOADING_INTERVAL_MS = 80;

const BRAILLE_LOADING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function toolLoadingIcon(now = Date.now()): string {
	return BRAILLE_LOADING_FRAMES[
		Math.floor(now / TOOL_LOADING_INTERVAL_MS) % BRAILLE_LOADING_FRAMES.length
	]!;
}
