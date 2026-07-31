# TODO

## 1. Add a subagent extension

- [ ] Compare the subagent implementations in Maka, Codex, and Oh My Pi.
- [ ] Identify two other popular Pi subagent packages for comparison.
- [ ] Document the feature/API differences, UX, process management, and trade-offs.
- [ ] Choose the smallest useful design for a new subagent extension.
- [ ] Implement, test, document, and publish the extension as its own package.

## 2. Verify background-terminal handoff

- [ ] Check whether a foreground terminal command can run for 10 seconds before being moved to the background.
- [ ] Test the handoff timing, output preservation, completion notification, cancellation, and `/ps` behavior.
- [ ] Update `pi-background-terminals` and its tests if the behavior needs changes.

## 3. Check the prune tool call

- [ ] Inspect the prune tool-call behavior in the Maka agent.
- [ ] Compare it with Pi's tool-result pruning and this repository's pruning design.
- [ ] Record compatibility concerns and decide whether to implement or adapt it.
