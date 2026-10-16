import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { loadSavedAgyToolMode, saveAgyToolMode } from "../lib/tool-mode-settings.ts";

test("saved tool mode survives new readers and Pi's own settings writes", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-tool-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "settings.json");
  assert.equal(loadSavedAgyToolMode(file), undefined);
  await writeFile(file, JSON.stringify({ theme: "dark", antigravity: { keep: true } }));
  const piSettings = SettingsManager.create(dir, dir);
  await saveAgyToolMode("pi", file);
  assert.equal(loadSavedAgyToolMode(file), "pi");
  piSettings.setTheme("light");
  await piSettings.flush();
  assert.deepEqual(piSettings.drainErrors(), []);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    theme: "light",
    antigravity: { keep: true, toolMode: "pi" },
  });
  await Promise.all([saveAgyToolMode("native", file), saveAgyToolMode("pi", file)]);
  assert.equal(loadSavedAgyToolMode(file), "pi");
  assert.deepEqual(await readdir(dir), ["settings.json"]);
});

test("malformed settings are preserved when saving fails", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-tool-settings-invalid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "settings.json");
  for (const text of ["{broken", "[]", '{"antigravity":"broken"}']) {
    await writeFile(file, text);
    assert.throws(() => loadSavedAgyToolMode(file));
    await assert.rejects(saveAgyToolMode("pi", file));
    assert.equal(await readFile(file, "utf8"), text);
    assert.deepEqual(await readdir(dir), ["settings.json"]);
  }
  await writeFile(file, '{"antigravity":{"toolMode":"broken"}}');
  assert.throws(() => loadSavedAgyToolMode(file), /antigravity.toolMode/);
});
