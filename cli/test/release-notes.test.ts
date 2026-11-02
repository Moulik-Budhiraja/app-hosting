// Tests scripts/common/release-notes.sh, which picks a release's notes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const script = fileURLToPath(new URL("../../scripts/common/release-notes.sh", import.meta.url));
let repo = "";
let temp = "";
const git = (...args: string[]) => {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  assert.equal(r.status, 0, r.stderr);
};

before(() => {
  repo = mkdtempSync(join(tmpdir(), "release-notes-repo-"));
  temp = mkdtempSync(join(tmpdir(), "release-notes-temp-"));
  git("init", "-q");
  mkdirSync(join(repo, "app"));
  writeFileSync(join(repo, "app", "apps.json"), "{}");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  git("tag", "-a", "v1.0.0", "-m", "Annotated subject\n\nAnnotated body line.");
  git("tag", "win-v1.0.0");
});
after(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
});

/** Runs the script from app/, as the actions do with directory: app. */
function notes(tag: string, notesFile?: string) {
  const r = spawnSync("bash", [script, tag, ...(notesFile === undefined ? [] : [notesFile])], {
    cwd: join(repo, "app"),
    encoding: "utf8",
    env: { ...process.env, SKIP_TAG_FETCH: "1", RUNNER_TEMP: temp },
  });
  const file = /^file=(.*)$/m.exec(r.stdout)?.[1];
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, text: file ? readFileSync(file, "utf8") : null };
}

test("without notes-file, the annotated tag's message is the notes, as before", () => {
  const annotated = notes("v1.0.0");
  assert.equal(annotated.code, 0, annotated.stderr);
  assert.equal(annotated.stdout, `file=${join(temp, "release-notes.md")}\n`);
  assert.equal(annotated.text, "Annotated subject\n\nAnnotated body line.\n\n");
  const lightweight = notes("win-v1.0.0");
  assert.deepEqual([lightweight.code, lightweight.stdout, lightweight.text], [0, "", null]);
  assert.deepEqual([notes("win-v1.0.0", "").stdout, notes("v1.0.0", "").text], ["", "Annotated subject\n\nAnnotated body line.\n\n"]);
});

test("a notes-file with text wins, relative to the repo root", () => {
  writeFileSync(join(repo, "app", "notes.md"), "## 0.7.27\n\n- From CHANGELOG.md\n");
  for (const tag of ["win-v1.0.0", "v1.0.0"]) {
    const r = notes(tag, "app/notes.md");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.text, "## 0.7.27\n\n- From CHANGELOG.md\n", tag);
    assert.equal(r.stderr, "");
  }
});

test("an empty or missing notes-file falls back to the tag message with a warning", () => {
  writeFileSync(join(repo, "app", "blank.md"), "  \n\t\n");
  for (const file of ["app/blank.md", "app/missing.md"]) {
    const annotated = notes("v1.0.0", file);
    assert.equal(annotated.code, 0, annotated.stderr);
    assert.equal(annotated.text, "Annotated subject\n\nAnnotated body line.\n\n", file);
    assert.match(annotated.stderr, new RegExp(`::warning::notes-file ${file} is missing or empty`));
    const lightweight = notes("win-v1.0.0", file);
    assert.deepEqual([lightweight.code, lightweight.stdout], [0, ""], file);
  }
  // A stale file from an earlier run doesn't leak into a release with no notes.
  assert.equal(notes("win-v1.0.0").stdout, "");
});

test("notes-file must stay inside the repo", () => {
  for (const file of ["/etc/hosts", "../outside.md", "app/../../outside.md", "C:\\notes.md", "app\\..\\..\\x.md"]) {
    const r = notes("v1.0.0", file);
    assert.equal(r.code, 1, file);
    assert.equal(r.stdout, "", file);
    assert.match(r.stderr, /notes-file (must be relative|can't contain \.\.)/, file);
  }
});
