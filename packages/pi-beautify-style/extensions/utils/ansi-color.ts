/** ANSI 16 色 → RGB（标准 xterm 色序）。 */
const ANSI_16_RGB: readonly [number, number, number][] = [
	[0, 0, 0],
	[128, 0, 0],
	[0, 128, 0],
	[128, 128, 0],
	[0, 0, 128],
	[128, 0, 128],
	[0, 128, 128],
	[192, 192, 192],
	[128, 128, 128],
	[255, 0, 0],
	[0, 255, 0],
	[255, 255, 0],
	[0, 0, 255],
	[255, 0, 255],
	[0, 255, 255],
	[255, 255, 255],
];

/** ANSI 16 色码（0-15）→ RGB；越界回退白。 */
export function ansi16ToRgb(index: number): [number, number, number] {
	return ANSI_16_RGB[index] ?? [255, 255, 255];
}

/** ANSI 256 色码 → RGB（0-15 标准色 + 232-255 灰阶 + 16-231 六阶立方体）。 */
export function ansi256ToRgb(code: number): [number, number, number] {
	// SGR 正则可解析任意位数字，入口先规范：取整并钳制到合法区间，
	// 否则灰阶分支对 code > 255 会算出超出 0-255 的非法 RGB。
	if (!Number.isFinite(code)) return [0, 0, 0];
	code = Math.min(255, Math.max(0, Math.trunc(code)));
	if (code < 16) return ansi16ToRgb(code);
	if (code >= 232) {
		const gray = 8 + (code - 232) * 10;
		return [gray, gray, gray];
	}
	const cubeIndex = code - 16;
	const levels = [0, 95, 135, 175, 215, 255];
	return [
		levels[Math.floor(cubeIndex / 36)]!,
		levels[Math.floor((cubeIndex % 36) / 6)]!,
		levels[cubeIndex % 6]!,
	];
}
