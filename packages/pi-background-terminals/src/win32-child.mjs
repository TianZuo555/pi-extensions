#!/usr/bin/env node

/**
 * Windows pre-shell launcher.
 *
 * This file is plain JavaScript because Node deliberately refuses to strip
 * TypeScript in node_modules. It joins the manager-created Job Object before
 * starting the requested shell, so every command process is born in the job.
 */

import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import koffi from "koffi";

const JOB_OBJECT_ASSIGN_PROCESS = 0x0001;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;

function fail(message) {
  writeSync(2, `Windows terminal launcher failed: ${message}\n`);
  process.exit(1);
}

function closeHandle(close, handle) {
  try {
    close(handle);
  } catch {
    // The process may be terminating or the handle may already be invalid.
  }
}

function joinJob(name) {
  if (process.platform !== "win32" || !name) {
    return { ok: false, reason: "not running on Windows or missing job name" };
  }
  try {
    const lib = koffi.load("kernel32.dll");
    const handle = koffi.pointer(koffi.opaque());
    const openProcess = lib.func("__stdcall", "OpenProcess", handle, [
      "uint32_t",
      "int8_t",
      "uint32_t",
    ]);
    const openJobObjectW = lib.func("__stdcall", "OpenJobObjectW", handle, [
      "uint32_t",
      "int8_t",
      "str16",
    ]);
    const assignProcessToJobObject = lib.func("__stdcall", "AssignProcessToJobObject", "int32_t", [
      handle,
      handle,
    ]);
    const close = lib.func("__stdcall", "CloseHandle", "int32_t", [handle]);
    const getLastError = lib.func("__stdcall", "GetLastError", "uint32_t", []);

    const job = openJobObjectW(JOB_OBJECT_ASSIGN_PROCESS, false, name);
    if (!job) return { ok: false, reason: `OpenJobObjectW error ${getLastError()}` };
    let currentProcess;
    try {
      currentProcess = openProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, false, process.pid);
      if (!currentProcess) {
        return { ok: false, reason: `OpenProcess error ${getLastError()}` };
      }
      if (!assignProcessToJobObject(job, currentProcess)) {
        return { ok: false, reason: `AssignProcessToJobObject error ${getLastError()}` };
      }
      return { ok: true };
    } finally {
      if (currentProcess) closeHandle(close, currentProcess);
      closeHandle(close, job);
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function readConfiguration() {
  let encoded = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) encoded += chunk;
  try {
    const value = JSON.parse(encoded);
    if (
      typeof value?.shell !== "string" ||
      value.shell.length === 0 ||
      !Array.isArray(value.args) ||
      !value.args.every((arg) => typeof arg === "string") ||
      (value.commandInput !== undefined && typeof value.commandInput !== "string")
    ) {
      fail("invalid launch configuration");
    }
    return value;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

const probe = process.argv[2] === "--probe";
const jobName = probe ? process.argv[3] : process.argv[2];
const joined = joinJob(jobName);
if (!joined.ok) fail(`could not join the process Job Object: ${joined.reason}`);
if (probe) process.exit(0);

// No command process exists before job membership is established.
const configuration = await readConfiguration();
let child;
try {
  child = spawn(configuration.shell, configuration.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: [configuration.commandInput === undefined ? "ignore" : "pipe", "inherit", "inherit"],
    windowsHide: true,
  });
  if (configuration.commandInput !== undefined) {
    child.stdin?.on("error", () => {});
    child.stdin?.end(configuration.commandInput);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

let finishing = false;
const finish = (code) => {
  if (finishing) return;
  finishing = true;
  process.exit(code);
};
child.once("error", (error) => {
  writeSync(2, `Windows terminal shell failed: ${error.message}\n`);
  finish(1);
});
child.once("exit", (code) => {
  // Exit as soon as the shell exits rather than waiting for inherited stdio.
  // The manager then closes the job after its bounded natural-exit grace.
  finish(code ?? 1);
});
