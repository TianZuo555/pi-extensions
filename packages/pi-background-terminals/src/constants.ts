export const MAX_RUNNING = 8;
export const MAX_TRACKED = 32;
export const DEFAULT_YIELD_TIME_MS = 10_000;
export const MIN_YIELD_TIME_MS = 250;
export const MAX_YIELD_TIME_MS = 30_000;
/** Node timer maximum, shared with Pi's built-in Bash timeout. */
export const MAX_RUNTIME_TIMEOUT_MS = 2_147_483_647;
export const MAX_RUNTIME_TIMEOUT_SECONDS = MAX_RUNTIME_TIMEOUT_MS / 1000;
/** In-memory retained cap and startup prefix per stream. */
export const RETAINED_PER_STREAM = 2 * 1024 * 1024;
export const HEAD_RETAINED_PER_STREAM = 256 * 1024;
export const MAX_SPILL_BYTES_PER_STREAM = 256 * 1024 * 1024;
export const MAX_TERMINAL_LOG_READ_BYTES = 64 * 1024;
export const TERMINAL_LOG_READ_RUN_BUDGET = MAX_TERMINAL_LOG_READ_BYTES * 4;
export const TERMINAL_LOG_READ_RUN_CALLS = 8;
