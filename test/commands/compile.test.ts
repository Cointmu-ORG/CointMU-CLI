import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { findImports } from "../../src/commands/compile";

describe("findImports path containment", () => {
  let cwd: string;
  let evilDir: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-compile-"));
    // Sibling directory whose absolute path shares a string prefix with cwd.
    evilDir = `${cwd}-evil`;
    fs.mkdirSync(evilDir, { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(evilDir, { recursive: true, force: true });
  });

  it("resolves a file that really lives inside the cwd", () => {
    fs.writeFileSync(path.join(cwd, "Local.sol"), "// local");
    expect(findImports("Local.sol")).toEqual({ contents: "// local" });
  });

  it("rejects a sibling path that only string-prefix matches the cwd", () => {
    fs.writeFileSync(path.join(evilDir, "secret.sol"), "// secret");
    const importPath = `../${path.basename(evilDir)}/secret.sol`;
    // Old startsWith() check would have read this file; containment must not.
    expect(findImports(importPath)).toEqual({
      error: "File not found or access denied",
    });
  });

  it("resolves a valid file from node_modules", () => {
    const pkgDir = path.join(cwd, "node_modules", "@openzeppelin", "contracts");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "Ownable.sol"), "// ownable");
    expect(findImports("@openzeppelin/contracts/Ownable.sol")).toEqual({
      contents: "// ownable",
    });
  });

  it("rejects a '../' traversal that escapes the cwd", () => {
    fs.writeFileSync(path.join(evilDir, "escape.sol"), "// escape");
    expect(findImports("../secret.sol")).toEqual({
      error: "File not found or access denied",
    });
  });
});

// The config file is require()d from the cwd, i.e. arbitrary code execution
// from the project directory. It must not run before the user has confirmed.
describe("runCompile trust gate", () => {
  let cwd: string;
  let marker: string;
  const realIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-trust-compile-"));
    marker = path.join(cwd, "executed.txt");
    fs.writeFileSync(
      path.join(cwd, "cmu.config.js"),
      `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");\n` +
        `module.exports = {};`,
    );
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    fs.rmSync(cwd, { recursive: true, force: true });
    process.stdin.isTTY = realIsTTY;
  });

  it("blocks in a non-TTY session and never loads the config", async () => {
    process.stdin.isTTY = false;
    const { runCompile } = await import("../../src/commands/compile");

    await expect(runCompile()).rejects.toThrow("exit:1");

    expect(fs.existsSync(marker)).toBe(false);
    const errors = (console.error as any).mock.calls.flat().join("\n");
    expect(errors).toMatch(/non-interactive session/);
    expect(errors).toMatch(/--yes/);
  });

  it("proceeds past the gate with --yes, without prompting", async () => {
    process.stdin.isTTY = false;
    const prompt = vi.fn();
    vi.doMock("inquirer", () => ({ default: { prompt } }));
    const { runCompile } = await import("../../src/commands/compile");

    // No contracts/ dir, so this is the first failure *after* the gate.
    await expect(runCompile({ yes: true })).rejects.toThrow("exit:1");

    expect(prompt).not.toHaveBeenCalled();
    expect(fs.existsSync(marker)).toBe(true);
    expect((console.error as any).mock.calls.flat().join("\n")).toMatch(
      /contracts\/ directory not found/,
    );
  });
});
