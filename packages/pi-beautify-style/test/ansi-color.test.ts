import assert from "node:assert/strict";
import test from "node:test";
import { ansi16ToRgb, ansi256ToRgb } from "../extensions/utils/ansi-color.ts";

test("ansi256ToRgb: 合法边界 0/15/16/231/232/255", () => {
	assert.deepEqual(ansi256ToRgb(0), [0, 0, 0]);
	assert.deepEqual(ansi256ToRgb(15), [255, 255, 255]);
	assert.deepEqual(ansi256ToRgb(16), [0, 0, 0]);
	assert.deepEqual(ansi256ToRgb(231), [255, 255, 255]);
	assert.deepEqual(ansi256ToRgb(232), [8, 8, 8]);
	assert.deepEqual(ansi256ToRgb(255), [238, 238, 238]);
});

test("ansi256ToRgb: 越界/非法输入钳制，不产生超出 0-255 的 RGB", () => {
	assert.deepEqual(ansi256ToRgb(-1), [0, 0, 0]);
	assert.deepEqual(ansi256ToRgb(256), [238, 238, 238]);
	assert.deepEqual(ansi256ToRgb(1000), [238, 238, 238]);
	assert.deepEqual(ansi256ToRgb(1.5), [128, 0, 0]);
	assert.deepEqual(ansi256ToRgb(Number.NaN), [0, 0, 0]);
	assert.deepEqual(ansi256ToRgb(Number.POSITIVE_INFINITY), [0, 0, 0]);
});

test("ansi16ToRgb: 越界回退白", () => {
	assert.deepEqual(ansi16ToRgb(-1), [255, 255, 255]);
	assert.deepEqual(ansi16ToRgb(16), [255, 255, 255]);
});
