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
