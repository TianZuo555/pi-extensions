#!/usr/bin/env node
/**
 * Fake Pi RPC child for supervisor tests — no model API required.
 *
 * Behavior modes via argv:
 *   --mode=settle          immediate agent_settled after prompt
 *   --mode=hang            never settles (tests timeout/kill)
 *   --mode=exit            accept prompt then exit immediately (crash simulation)
 *   --mode=report          structured report_result then settle
 *   --mode=report-blocked  blocked report_result
 *   --mode=report-failed   failed report_result
 *   --mode=report-bad      malformed report_result details
 *   --mode=turns           emit turn_start beyond budget then settle
 *   --mode=turns-report    wait for steer warning, grace turn, then report_result
 *   --mode=no-report       settle without report_result (text fallback)
 *   --mode=write-exit      write orphan-change.txt then exit before settling
 *   --mode=report-nested-bad  valid status/summary but invalid nested field
 */

import { createInterface } from "node:readline";
import * as fs from "node:fs";

const mode = process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1] ?? "settle";
const maxTurns = Number(process.argv.find((a) => a.startsWith("--max-turns="))?.split("=")[1] ?? "8");
const TURN_DELAY_MS = 15;

const rl = createInterface({ input: process.stdin });

let promptActive = false;
let emittedTurnCount = 0;
let steerObserved = false;
let turnTimer = null;

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function reportDetails(status) {
  return {
    status,
    summary: `fake structured ${status} report`,
    changes: [{ path: "src/example.ts", summary: "updated example" }],
  };
}

function emitReport(status, malformed = false) {
  write({
    type: "tool_execution_end",
    toolCallId: "call_report",
    toolName: "report_result",
    result: {
      content: [{ type: "text", text: `Reported: ${status}` }],
      details: malformed ? { status, summary: 123 } : reportDetails(status),
    },
    isError: false,
  });
}

function emitTurns(count) {
  for (let i = 0; i < count; i++) {
    write({ type: "turn_start" });
    write({ type: "turn_end", messages: [] });
  }
}

function stopTurnLoop() {
  if (turnTimer) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }
  promptActive = false;
}

function scheduleNextTurn() {
  if (!promptActive) return;
  turnTimer = setTimeout(() => {
    turnTimer = null;
    emitOneTurn();
  }, TURN_DELAY_MS);
}

function finishAfterReport() {
  emitReport("completed");
  write({ type: "agent_settled" });
  stopTurnLoop();
}

function emitOneTurn() {
  if (!promptActive) return;

  emittedTurnCount++;
  write({ type: "turn_start" });
  write({ type: "turn_end", messages: [] });

  if (mode === "turns-report") {
    if (steerObserved) {
      finishAfterReport();
      return;
    }
    scheduleNextTurn();
    return;
  }

  if (mode === "turns") {
    scheduleNextTurn();
  }
}

function startAsyncTurnLoop() {
  promptActive = true;
  emittedTurnCount = 0;
  steerObserved = false;
  scheduleNextTurn();
}

function respond(cmd, body) {
  write({ type: "response", id: cmd.id, ...body });
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }

  switch (cmd.type) {
    case "prompt":
      if (mode === "write-exit") {
        fs.writeFileSync("orphan-change.txt", "orphan\n");
        process.exit(1);
      }
      write({ type: "agent_start" });
      respond(cmd, { command: "prompt", success: true });
      if (mode === "settle" || mode === "no-report") {
        write({ type: "agent_end", messages: [], willRetry: false });
        write({ type: "agent_settled" });
      } else if (mode === "report") {
        emitReport("completed");
        write({ type: "agent_settled" });
      } else if (mode === "report-blocked") {
        emitReport("blocked");
        write({ type: "agent_settled" });
      } else if (mode === "report-failed") {
        emitReport("failed");
        write({ type: "agent_settled" });
      } else if (mode === "report-bad") {
        emitReport("completed", true);
        write({ type: "agent_settled" });
      } else if (mode === "turns" || mode === "turns-report") {
        startAsyncTurnLoop();
      } else if (mode === "report-nested-bad") {
        write({
          type: "tool_execution_end",
          toolCallId: "call_report",
          toolName: "report_result",
          result: {
            content: [{ type: "text", text: "Reported: completed" }],
            details: {
              status: "completed",
              summary: "looks valid at top level",
              changes: [{ path: "src/example.ts", summary: 123 }],
            },
          },
          isError: false,
        });
        write({ type: "agent_settled" });
      } else if (mode === "agent-end") {
        write({ type: "agent_end", messages: [], willRetry: false });
      } else if (mode === "exit") {
        process.exit(1);
      }
      break;
    case "steer":
      respond(cmd, { command: "steer", success: true });
      if (mode === "turns-report" && promptActive && !steerObserved) {
        steerObserved = true;
        scheduleNextTurn();
      }
      break;
    case "abort":
      write({ type: "agent_settled" });
      respond(cmd, { command: "abort", success: true });
      stopTurnLoop();
      break;
    case "get_last_assistant_text":
      respond(cmd, {
        command: "get_last_assistant_text",
        success: true,
        data: { text: "fake subagent report" },
      });
      break;
    case "get_session_stats":
      respond(cmd, {
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
      respond(cmd, { command: cmd.type, success: true });
  }
});
