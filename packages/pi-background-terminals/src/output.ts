/**
 * OutputBuffer — bounded head+tail in-memory capture of one process stream.
 *
 * A stable prefix and rolling suffix are retained; once output exceeds the cap,
 * bytes from the middle are omitted. A single oversized chunk is split only on
 * UTF-8 code point boundaries. An optional spill callback receives every chunk
 * in order before retention, so the caller can keep a complete on-disk copy.
 *
 * Plain TS by design: this is push-based accumulation driven by node stream
 * 'data' callbacks, not stream transformation.
 */

import type { OutputView } from "./domain.ts";

function utf8Prefix(raw: Buffer, maxBytes: number) {
  if (raw.length <= maxBytes) return raw;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (raw[end] & 0xc0) === 0x80) end--;
  // Copy the bounded slice so retaining it cannot pin one giant source Buffer.
  return Buffer.from(raw.subarray(0, end));
}

function utf8Tail(raw: Buffer, maxBytes: number) {
  if (raw.length <= maxBytes) return raw;
  let start = raw.length - Math.max(0, maxBytes);
  while (start < raw.length && (raw[start] & 0xc0) === 0x80) start++;
  // Copy the bounded slice so retaining it cannot pin one giant source Buffer.
  return Buffer.from(raw.subarray(start));
}

export class OutputBuffer {
  private headChunks: Buffer[] = [];
  private tailChunks: Buffer[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  /** Once any byte spills past the head budget, later bytes can only be tail. */
  private headSealed = false;
  private cachedView: OutputView | undefined;

  /** Bumped on every push; lets the UI cache derived line layouts. */
  version = 0;
  totalBytes = 0;
  private _spillPath?: string;
  private _archiveComplete = false;

  get spillPath() {
    return this._spillPath;
  }

  set spillPath(value: string | undefined) {
    if (this._spillPath === value) return;
    this._spillPath = value;
    if (value === undefined) this._archiveComplete = false;
    this.cachedView = undefined;
  }

  get archiveComplete() {
    return this._archiveComplete;
  }

  set archiveComplete(value: boolean) {
    if (this._archiveComplete === value) return;
    this._archiveComplete = value;
    this.cachedView = undefined;
  }

  private readonly maxRetainedBytes: number;
  private readonly headBudget: number;
  private readonly tailBudget: number;
  private readonly spill?: (chunk: string) => unknown;

  constructor(
    maxRetainedBytes: number,
    spill?: (chunk: string) => unknown,
    headRetainedBytes = Math.floor(maxRetainedBytes / 8),
  ) {
    this.maxRetainedBytes = Math.max(0, maxRetainedBytes);
    this.headBudget = Math.min(this.maxRetainedBytes, Math.max(0, headRetainedBytes));
    this.tailBudget = this.maxRetainedBytes - this.headBudget;
    this.spill = spill;
    this.headSealed = this.headBudget === 0;
  }

  push(chunk: string) {
    if (chunk.length === 0) return true;

    const raw = Buffer.from(chunk, "utf8");
    this.totalBytes += raw.length;
    const spillAccepted = this.spill?.(chunk) !== false;
    let remainder = raw;

    if (!this.headSealed) {
      const available = this.headBudget - this.headBytes;
      const prefix = utf8Prefix(raw, available);
      if (prefix.length > 0) {
        this.headChunks.push(prefix);
        this.headBytes += prefix.length;
      }
      remainder = raw.subarray(prefix.length);
      if (remainder.length > 0) this.headSealed = true;
    }

    this.pushTail(remainder);
    this.cachedView = undefined;
    this.version++;
    return spillAccepted;
  }

  private pushTail(raw: Buffer) {
    if (raw.length === 0 || this.tailBudget === 0) return;

    if (raw.length >= this.tailBudget) {
      const kept = utf8Tail(raw, this.tailBudget);
      this.tailChunks = kept.length > 0 ? [kept] : [];
      this.tailBytes = kept.length;
      return;
    }

    this.tailChunks.push(raw);
    this.tailBytes += raw.length;
    while (this.tailBytes > this.tailBudget && this.tailChunks.length > 0) {
      const excess = this.tailBytes - this.tailBudget;
      const first = this.tailChunks[0];
      if (first.length <= excess) {
        this.tailChunks.shift();
        this.tailBytes -= first.length;
        continue;
      }

      let start = excess;
      while (start < first.length && (first[start] & 0xc0) === 0x80) start++;
      if (start >= first.length) {
        this.tailChunks.shift();
        this.tailBytes -= first.length;
      } else {
        this.tailChunks[0] = first.subarray(start);
        this.tailBytes -= start;
      }
    }
  }

  view(): OutputView {
    if (this.cachedView) return this.cachedView;

    const head = Buffer.concat(this.headChunks, this.headBytes).toString("utf8");
    const tail = Buffer.concat(this.tailChunks, this.tailBytes).toString("utf8");
    const truncatedBytes = Math.max(0, this.totalBytes - this.headBytes - this.tailBytes);
    const text =
      truncatedBytes === 0
        ? `${head}${tail}`
        : [head, `... ${truncatedBytes} bytes omitted ...`, tail]
            .filter((part) => part.length > 0)
            .join("\n");

    this.cachedView = {
      text,
      head,
      tail,
      totalBytes: this.totalBytes,
      truncatedBytes,
      spillPath: this._spillPath,
      archiveComplete: this._archiveComplete,
    };
    return this.cachedView;
  }
}
