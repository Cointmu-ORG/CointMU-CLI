import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { run } from "../../src/utils/exec";

// Regression tests for #232: since CVE-2024-27980, spawning npm.cmd or npx.cmd
// without a shell throws EINVAL. They only mean something on Windows.
const isWindows = process.platform === "win32";

// Characters cmd.exe would re-parse, plus quoting and empty-argument cases.
const ODD_ARGS = [
  "a&b|c^%PATH%",
  "x y",
  'q"q',
  "",
  "'s'",
  "`id`",
  "$HOME",
  "\\\\srv\\a b\\",
];

describe("run on win32", () => {
  let fakeNpmDir: string;

  beforeEach(() => {
    fakeNpmDir = mkdtempSync(path.join(tmpdir(), "cmu-fake-npm-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(fakeNpmDir, { recursive: true, force: true });
  });

  it.runIf(isWindows)("starts the real npm", async () => {
    await expect(run("npm", ["--version"])).resolves.toBeUndefined();
  });

  it.runIf(isWindows)("starts the real npx", async () => {
    await expect(run("npx", ["--version"])).resolves.toBeUndefined();
  });

  it.runIf(isWindows)(
    "hands odd arguments to npm's entry script unchanged",
    async () => {
      // npm.cmd only marks the directory, as it does in a real install; the
      // entry script beside it exits 0 only when it sees ODD_ARGS verbatim.
      const binDir = path.join(fakeNpmDir, "node_modules", "npm", "bin");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(path.join(fakeNpmDir, "npm.cmd"), "");
      writeFileSync(
        path.join(binDir, "npm-cli.js"),
        `const expected = ${JSON.stringify(JSON.stringify(ODD_ARGS))};\n` +
          "process.exit(JSON.stringify(process.argv.slice(2)) === expected ? 0 : 9);\n",
      );
      vi.stubEnv("PATH", `${fakeNpmDir};${process.env.PATH ?? ""}`);

      await expect(run("npm", ODD_ARGS)).resolves.toBeUndefined();
    },
  );
});
