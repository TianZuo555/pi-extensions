#!/usr/bin/env node
/**
 * Fake Pi RPC child for supervisor tests — no model API required.
 *
 * Behavior modes via argv:
 *   --mode=settle     immediate agent_settled after prompt
 *   --mode=hang       never settles (tests timeout/kill)
 *   --mode=exit      accept prompt then exit immediately (crash simulation)
 */

import { createInterface } from "node:readline";

const mode = process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1] ?? "settle";

const rl = createInterface({ input: process.stdin });

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }

  const id = cmd.id;
  const respond = (body) => {
    write({ type: "response", id, ...body });
  };

  switch (cmd.type) {
    case "prompt":
      write({ type: "agent_start" });
      respond({ command: "prompt", success: true });
      if (mode === "settle") {
        write({ type: "agent_end", messages: [], willRetry: false });
        write({ type: "agent_settled" });
      } else if (mode === "agent-end") {
        write({ type: "agent_end", messages: [], willRetry: false });
      } else if (mode === "exit") {
        process.exit(1);
      }
      break;
    case "abort":
      write({ type: "agent_settled" });
      respond({ command: "abort", success: true });
      break;
    case "get_last_assistant_text":
      respond({
        command: "get_last_assistant_text",
        success: true,
        data: { text: "fake subagent report" },
      });
      break;
    case "get_session_stats":
      respond({
        command: "get_session_stats",
        success: true,
        data: {
          sessionId: "fake",
          userMessages: 1,
          assistantMessages: 1,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 2,
          tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
          cost: 0.001,
        },
      });
      break;
    default:
      respond({ command: cmd.type, success: true });
  }
});
