/** Shared on-disk locations for agy's own CLI state. */

import * as os from "node:os";
import * as path from "node:path";

/** Per-conversation state root (`brain/<conversation-id>/`). */
export function agyBrainDir(home = os.homedir()): string {
  return path.join(home, ".gemini", "antigravity-cli", "brain");
}
