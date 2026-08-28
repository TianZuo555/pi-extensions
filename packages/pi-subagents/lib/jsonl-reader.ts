/**
 * Strict JSONL reader for Pi RPC mode.
 * Splits on LF only; strips trailing CR. Does not split on U+2028/U+2029.
 */

import { StringDecoder } from "node:string_decoder";

export interface JsonlReader {
  push(chunk: Buffer | string): void;
  end(): void;
}

export function attachJsonlReader(
  stream: {
    on(event: "data", listener: (chunk: Buffer) => void): void;
    on(event: "end", listener: () => void): void;
  },
  onLine: (line: string) => void,
): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const emitLine = (raw: string) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.length > 0) onLine(line);
  };

  stream.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      emitLine(line);
    }
  });

  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer.length > 0) emitLine(buffer);
  });
}
