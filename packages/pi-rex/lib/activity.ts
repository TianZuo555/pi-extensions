const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const MAX_MESSAGE_BYTES = 192;

type ActivityState = "idle" | "working" | "done" | "error" | "clear";

type Write = (data: string) => void;

export interface RexActivityReporter {
  clear(): void;
  working(message: string): void;
  done(message: string): void;
  error(message: string): void;
  idle(): void;
}

function truncateUtf8(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_MESSAGE_BYTES) return text;

  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > MAX_MESSAGE_BYTES) break;
    bytes += size;
    end += character.length;
  }
  return text.slice(0, end);
}

/** Make one-line text safe for the OSC 7501 message field. */
export function summarizeActivity(text: string): string {
  return truncateUtf8(text.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim());
}

/** Address a separate record so Pi can keep reporting its own root status. */
export function formatRexActivityStatus(state: ActivityState, message?: string): string {
  const pairs = [`state=${state}`, "id=pi-prompt", "app=pi"];
  const summary = message ? summarizeActivity(message) : "";
  if (summary) pairs.push(`msg=${Buffer.from(summary, "utf8").toString("base64")}`);
  return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}

function canReportActivity(): boolean {
  return process.env.PI_PROGRAM_STATUS !== "0" && process.stdout.isTTY === true;
}

export function createRexActivityReporter(
  write: Write = process.stdout.write.bind(process.stdout),
  enabled: () => boolean = canReportActivity,
): RexActivityReporter {
  let lastReport = "";

  const report = (state: ActivityState, message?: string): void => {
    if (!enabled()) return;
    const sequence = formatRexActivityStatus(state, message);
    if (sequence === lastReport) return;
    lastReport = sequence;
    write(sequence);
  };

  return {
    clear() {
      if (lastReport) report("clear");
    },
    working(message) {
      report("working", message);
    },
    done(message) {
      report("done", message);
    },
    error(message) {
      report("error", message);
    },
    idle() {
      report("idle");
    },
  };
}
