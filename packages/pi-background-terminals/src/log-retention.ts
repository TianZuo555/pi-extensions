/**
 * Log files of settled terminals stay until the session ends, so a result can
 * give their path. Past the byte limit, the oldest files go first. The newest
 * terminal's files stay even when they alone pass the limit.
 */

import * as fs from "node:fs";

function fileBytes(file: string) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export function createLogRetention(limitBytes: number) {
  const kept: Array<{ readonly paths: readonly string[]; readonly bytes: number }> = [];
  let total = 0;
  return {
    /** Record one settled terminal's log files. Returns the files to delete. */
    add(paths: readonly string[]) {
      const bytes = paths.reduce((sum, file) => sum + fileBytes(file), 0);
      kept.push({ paths, bytes });
      total += bytes;
      const expired: string[] = [];
      while (total > limitBytes && kept.length > 1) {
        const oldest = kept.shift();
        if (!oldest) break;
        total -= oldest.bytes;
        expired.push(...oldest.paths);
      }
      return expired;
    },
  };
}
