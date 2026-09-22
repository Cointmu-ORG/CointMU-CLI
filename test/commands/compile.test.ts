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

    // runCompile reports by throwing; the command handler turns that into the
    // "compile failed" banner and the exit code.
    await expect(runCompile()).rejects.toThrow(/non-interactive session/);
    await expect(runCompile()).rejects.toThrow(/--yes/);

    expect(fs.existsSync(marker)).toBe(false);
  });

  it("proceeds past the gate with --yes, without prompting", async () => {
    process.stdin.isTTY = false;
    const prompt = vi.fn();
    vi.doMock("inquirer", () => ({ default: { prompt } }));
    const { runCompile } = await import("../../src/commands/compile");

    // No contracts/ dir, so this is the first failure *after* the gate.
    await expect(runCompile({ yes: true })).rejects.toThrow(
      /contracts\/ directory not found/,
    );

    expect(prompt).not.toHaveBeenCalled();
    expect(fs.existsSync(marker)).toBe(true);
  });
});

// Both `cmu compile` and `cmu deploy` register ts-node to require() a
// cmu.config.ts. They used to do it two different ways, and compile's swallowed
// the failure behind a warning, so a broken registration silently downgraded to
// default compiler settings instead of reporting anything. Both go through
// registerTsNode() now; this pins compile's half.

describe("runCompile config loading", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-compile-cfg-"));
    fs.mkdirSync(path.join(tmpDir, "contracts"));
    fs.writeFileSync(
      path.join(tmpDir, "contracts", "Tiny.sol"),
      "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract Tiny {}\n",
    );
    // ts-node resolves "typescript" from the project being loaded, so the
    // fixture needs a real one to resolve.
    fs.mkdirSync(path.join(tmpDir, "node_modules"));
    fs.symlinkSync(
      path.resolve(__dirname, "../../node_modules/typescript"),
      path.join(tmpDir, "node_modules", "typescript"),
      "dir",
    );
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads a real cmu.config.ts instead of warning and falling back", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "cmu.config.ts"),
      `export default { compiler: { settings: { optimizer: { enabled: true, runs: 999 } } } };`,
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { runCompile } = await import("../../src/commands/compile");
    await runCompile({ yes: true });

    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("could not load"),
    );
    expect(fs.existsSync(path.join(tmpDir, "artifacts", "Tiny.json"))).toBe(
      true,
    );
  });
});

// The gate `cmu compile` shows is also the first one `cmu test` and `cmu deploy`
// reach, so its wording has to follow the calling command. `cmu test` runs every
// file in test/ with a PRIVATE_KEY in the environment: telling it "this command
// does not sign anything" would be worse than saying nothing.
describe("runCompile trust wording", () => {
  let cwd: string;
  let confirmProjectTrust: ReturnType<typeof vi.fn>;

  async function loadCompile() {
    vi.resetModules();
    confirmProjectTrust = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../../src/utils/trust", () => ({
      confirmProjectTrust,
      findProjectConfig: () => path.join(cwd, "cmu.config.js"),
    }));
    return import("../../src/commands/compile");
  }

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-compile-trust-"));
    fs.writeFileSync(path.join(cwd, "cmu.config.js"), "module.exports = {};");
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../../src/utils/trust");
    vi.resetModules();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // No contracts/ here, so the run stops just past the gate - which is all
  // these two cases are about.
  it("does not claim read-only when the caller did not say so", async () => {
    const { runCompile } = await loadCompile();

    await expect(runCompile()).rejects.toThrow(/contracts\/ directory/);

    expect(confirmProjectTrust).toHaveBeenCalledWith(
      [path.join(cwd, "cmu.config.js")],
      expect.objectContaining({ variant: undefined }),
    );
  });

  it("passes the caller's read-only claim through (cmu compile)", async () => {
    const { runCompile } = await loadCompile();

    await expect(runCompile({ variant: "readOnly" })).rejects.toThrow(
      /contracts\/ directory/,
    );

    expect(confirmProjectTrust).toHaveBeenCalledWith(
      [path.join(cwd, "cmu.config.js")],
      expect.objectContaining({ variant: "readOnly" }),
    );
  });
});
