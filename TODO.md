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

## 4. Code review follow-ups

- [ ] Make machine-local JSON updates atomic and serialize read-modify-write operations across concurrent Pi sessions. This affects repository model/skill settings, token-speed settings, subagent trust, and web-search configuration.
- [ ] Validate every image-cache manifest field before restoring an entry, and recover from structurally invalid manifests instead of only malformed JSON.
- [ ] Add a bounded VS Code bridge handshake and close the socket when a pending connection is interrupted, so a silent or half-open server cannot leave an attachment attempt pending indefinitely.
- [ ] Apply response-size limits to all remote search/fetch providers, not only direct fetch, before parsing their response bodies.
- [ ] Replace duplicated source copies (notably repository registry and VS Code protocol files) with a generated or shared source workflow that preserves independently publishable packages.
- [ ] Resolve the remaining Effect language-service advisory in the VS Code bridge disconnect path.
