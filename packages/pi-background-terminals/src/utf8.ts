/**
 * UTF-8 window boundaries for byte-addressed archive reads.
 *
 * A byte offset chosen by the model can land anywhere inside a code point, so
 * a read window must be snapped at both ends before it is decoded. Snapping is
 * done on bytes rather than on decoded text: the archive is addressed in bytes
 * and paging continuity depends on the returned range being exact.
 */

/** Offset of the first code-point start at or after the buffer start. */
export function codePointStart(buf: Buffer) {
  let index = 0;
  // At most three continuation bytes can precede a code-point boundary.
  while (index < buf.length && index < 3 && (buf[index] & 0xc0) === 0x80) {
    index++;
  }
  return index;
}

/**
 * Length of the longest prefix that ends on a complete code point. A trailing
 * sequence that the window cut short is excluded so the next page can start at
 * its lead byte and decode it whole.
 */
export function completeCodePointEnd(buf: Buffer) {
  let index = buf.length - 1;
  let continuations = 0;
  while (index >= 0 && (buf[index] & 0xc0) === 0x80 && continuations < 3) {
    index--;
    continuations++;
  }
  if (index < 0) return buf.length;
  const lead = buf[index];
  const needed =
    lead < 0x80
      ? 1
      : lead >= 0xf0
        ? 4
        : lead >= 0xe0
          ? 3
          : lead >= 0xc0
            ? 2
            : 0;
  // A stray continuation byte is not a truncated sequence; leave it in place
  // rather than trimming an unbounded tail of invalid bytes.
  if (needed === 0) return buf.length;
  return buf.length - index >= needed ? buf.length : index;
}
