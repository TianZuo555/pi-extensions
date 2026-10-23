/**
 * SGR 鼠标协议解析（共享）。
 *
 * 收敛 feature/_util.ts 的单包解析与 renderer/mouse/packets.ts 的批量解析。
 */

/** SGR 鼠标协议包（code;col;row + M/m 终结符）。 */
export type SgrMousePacket = {
	code: number;
	col: number;
	row: number;
	final: "M" | "m";
};

/** 解析单个完整 SGR 鼠标包（整段数据必须恰好是一个包）。 */
export function parseSgrMousePacket(data: string): SgrMousePacket | null {
	const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (!match) return null;
	return {
		code: Number(match[1]),
		col: Number(match[2]),
		row: Number(match[3]),
		final: match[4] as "M" | "m",
	};
}

/**
 * 解析整段终端输入为 SGR 鼠标包序列；数据必须完全由连续 SGR 包组成
 * （夹杂其他字节返回 null，交由常规输入链处理）。
 */
export function parseSgrMousePackets(data: string): SgrMousePacket[] | null {
	const pattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
	const packets: SgrMousePacket[] = [];
	let offset = 0;

	for (const match of data.matchAll(pattern)) {
		if (match.index !== offset) return null;
		offset = match.index + match[0].length;
		packets.push({
			code: Number(match[1]),
			col: Number(match[2]),
			row: Number(match[3]),
			final: match[4] as "M" | "m",
		});
	}

	return packets.length > 0 && offset === data.length ? packets : null;
}

/** 是否为左键按下（排除修饰键、32 表示 motion 事件）。 */
export function isSgrLeftPress(packet: SgrMousePacket): boolean {
	const baseButton = mouseBaseButton(packet.code);
	return packet.final === "M" && baseButton === 0 && (packet.code & 32) === 0;
}

/** 是否为左键松开。 */
export function isSgrLeftRelease(packet: SgrMousePacket): boolean {
	const baseButton = mouseBaseButton(packet.code);
	return packet.final === "m" && baseButton === 0 && (packet.code & 32) === 0;
}

/** 无按键按住的指针移动（DECSET 1003 的 35）。左键拖动（32，文本选区）不是 hover。 */
export function isSgrIdleMotion(packet: SgrMousePacket): boolean {
	return packet.final === "M" && (packet.code & 32) !== 0 && mouseBaseButton(packet.code) === 3;
}

/** 剥离修饰键位（4/8/16/32：shift/meta/ctrl/motion），得到基础按键码。 */
export function mouseBaseButton(code: number): number {
	return code & ~(4 | 8 | 16 | 32);
}
