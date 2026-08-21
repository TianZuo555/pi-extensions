import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  findAgyArtifact,
  listAgyArtifacts,
  type AgyArtifact,
} from "../lib/artifacts.ts";

const CONV = "conv-1";

async function makeBrain(): Promise<string> {
  const brainDir = await mkdtemp(path.join(tmpdir(), "agy-artifacts-"));
  const generated = path.join(brainDir, CONV, ".tempmediaStorage");
  const uploaded = path.join(brainDir, CONV, ".user_uploaded");
  await mkdir(generated, { recursive: true });
  await mkdir(uploaded, { recursive: true });
  await writeFile(path.join(generated, "media_1.png"), "png-bytes");
  await writeFile(path.join(uploaded, "upload_1.pdf"), "%PDF-1.4");
  // Make media_1 the newest so sorting is observable.
  const later = new Date(Date.now() + 60_000);
  await utimes(path.join(generated, "media_1.png"), later, later);
  return brainDir;
}

test("listAgyArtifacts lists generated and uploaded files, newest first", async () => {
  const brainDir = await makeBrain();
  try {
    const artifacts = await listAgyArtifacts(CONV, { brainDir });
    assert.deepEqual(
      artifacts.map((artifact) => artifact.name),
      ["media_1.png", "upload_1.pdf"],
    );
    assert.equal(artifacts[0].kind, "generated");
    assert.equal(artifacts[0].mediaType, "image");
    assert.equal(artifacts[1].kind, "uploaded");
    assert.equal(artifacts[1].mediaType, "pdf");
    assert.equal(artifacts[0].bytes, 9);
  } finally {
    await rm(brainDir, { recursive: true, force: true });
  }
});

test("listAgyArtifacts returns empty when the conversation has no artifacts", async () => {
  const brainDir = await mkdtemp(path.join(tmpdir(), "agy-artifacts-"));
  try {
    assert.deepEqual(await listAgyArtifacts("missing-conv", { brainDir }), []);
  } finally {
    await rm(brainDir, { recursive: true, force: true });
  }
});

test("findAgyArtifact matches exact name then unique prefix", () => {
  const artifacts = [
    { name: "media_1.png" },
    { name: "media_2.png" },
    { name: "upload_1.pdf" },
  ] as AgyArtifact[];
  assert.equal(findAgyArtifact(artifacts, "media_1.png")?.name, "media_1.png");
  assert.equal(findAgyArtifact(artifacts, "upl")?.name, "upload_1.pdf");
  assert.equal(findAgyArtifact(artifacts, "media"), undefined); // ambiguous
  assert.equal(findAgyArtifact(artifacts, "nope"), undefined);
});
