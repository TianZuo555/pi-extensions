import { TerminalManager } from "./src/manager.ts";
import { createTerminalRuntime, runTool } from "./src/runtime.ts";

const runtime = createTerminalRuntime();
const manager = await runtime.runPromise(TerminalManager);
const command = `node -e "setInterval(() => {}, 1000)"`;
const snap = await runTool(
  runtime,
  manager.start({
    command,
    title: "crash-safety-fixture",
    cwd: process.cwd(),
  }),
);

if (!snap.pid) throw new Error("fixture child has no pid");
process.stdout.write(`${snap.pid}\n`, () => {
  // Deliberately bypass runtime.dispose()/session_shutdown. The manager's
  // synchronous process-exit safety net must terminate the managed tree.
  process.exit(23);
});
