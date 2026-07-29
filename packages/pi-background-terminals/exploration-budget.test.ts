import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPLORATION_LIMIT,
  EXPLORATION_WARNING_AT,
  explorationLimitError,
  explorationWarning,
  isExploratoryBashCommand,
} from "./src/exploration-budget.ts";

test("recognizes common shell inspection including long path assignments", () => {
  assert.equal(isExploratoryBashCommand("rg context src"), true);
  assert.equal(
    isExploratoryBashCommand(
      "D=/very/long/pi/path; grep -rn 'contextTokens' $D/docs/*.md | head -20",
    ),
    true,
  );
  assert.equal(isExploratoryBashCommand("cd pkg && npm test"), false);
  assert.equal(isExploratoryBashCommand("npm test | head -20"), false);
  assert.equal(isExploratoryBashCommand("ls > files.txt"), false);
  assert.equal(isExploratoryBashCommand("ls 2>errors.txt"), false);
  assert.equal(isExploratoryBashCommand("ls >/dev/null"), true);
  assert.equal(isExploratoryBashCommand("npm run build"), false);
});

test("warning and limit messages direct the model to synthesize", () => {
  assert.equal(explorationWarning(EXPLORATION_WARNING_AT - 1), undefined);
  assert.match(
    explorationWarning(EXPLORATION_WARNING_AT) ?? "",
    new RegExp(`${EXPLORATION_WARNING_AT}/${EXPLORATION_LIMIT}`),
  );
  assert.match(explorationWarning(EXPLORATION_LIMIT) ?? "", /synthesize/i);
  assert.equal(explorationWarning(EXPLORATION_LIMIT + 1), undefined);
  assert.match(explorationLimitError(), /was not executed/i);
  assert.match(explorationLimitError(), /synthesize/i);
});
