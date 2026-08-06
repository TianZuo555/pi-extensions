import assert from "node:assert/strict";
import test from "node:test";
import {
  createSubagentRuntime,
  runSubagent,
  SubagentNotInitializedError,
  SubagentRuntime,
  SubagentRuntimeClosedError,
  SubagentRunError,
} from "../src/runtime.ts";

test("SubagentRuntime rejects operations before init with NotInitializedError", async () => {
  const runtime = createSubagentRuntime();
  const subagent = runtime.runSync(SubagentRuntime);

  await assert.rejects(
    () => runSubagent(runtime, subagent.run({} as never)),
    (error: unknown) => error instanceof SubagentNotInitializedError,
  );

  await runSubagent(runtime, subagent.close);
  await runtime.dispose();
});

test("SubagentRuntime close rejects further operations with ClosedError", async () => {
  const runtime = createSubagentRuntime();
  const subagent = runtime.runSync(SubagentRuntime);

  await runSubagent(runtime, subagent.init(process.cwd()));
  await runSubagent(runtime, subagent.close);

  await assert.rejects(
    () => runSubagent(runtime, subagent.run({} as never)),
    (error: unknown) => {
      assert.ok(error instanceof SubagentRuntimeClosedError);
      assert.equal(error instanceof SubagentNotInitializedError, false);
      assert.equal(error instanceof SubagentRunError, false);
      return true;
    },
  );

  await runtime.dispose();
});

test("SubagentRunError is distinct from lifecycle errors", () => {
  const runError = new SubagentRunError({ message: "boom", cause: new Error("boom") });
  const closed = new SubagentRuntimeClosedError({ message: "closed" });
  const notInit = new SubagentNotInitializedError({ message: "not init" });

  assert.equal(runError instanceof SubagentRunError, true);
  assert.equal(runError instanceof SubagentRuntimeClosedError, false);
  assert.equal(closed instanceof SubagentNotInitializedError, false);
  assert.equal(notInit instanceof SubagentRunError, false);
});
