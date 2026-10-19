import { describe, expect, it } from "vitest";
import path from "path";
import {
  CommandHost,
  NpmEntryNotFoundError,
  currentHost,
  resolveCommand,
} from "../../src/utils/npmCommand";

// Windows layouts are described with path.win32 so these run on every OS.
const join = path.win32.join;

const INSTALL_DIR = "C:\\Program Files\\nodejs";
const NODE_DIR = "C:\\hostedtoolcache\\node\\24.0.0\\x64";
const NODE_EXE = join(NODE_DIR, "node.exe");

/** The entry script npm keeps under an install directory. */
function entry(dir: string, script: string): string {
  return join(dir, "node_modules", "npm", "bin", script);
}

/** The shim and both entry scripts, the way an npm install lays them out. */
function npmInstall(dir: string): string[] {
  return [
    join(dir, "npm.cmd"),
    entry(dir, "npm-cli.js"),
    entry(dir, "npx-cli.js"),
  ];
}

/** A host on which exactly `files` exist. */
function host(
  files: string[],
  pathEnv: string | undefined,
  platform: NodeJS.Platform = "win32",
): CommandHost {
  const existing = new Set(files);
  return {
    platform,
    pathEnv,
    execPath: NODE_EXE,
    exists: (file) => existing.has(file),
  };
}

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

describe("resolveCommand off Windows", () => {
  it("passes npm through unchanged on linux", () => {
    const linux = host([], "/usr/bin", "linux");
    expect(resolveCommand("npm", ["install", "ethers"], linux)).toEqual({
      file: "npm",
      args: ["install", "ethers"],
    });
  });

  it("passes npx through unchanged on darwin", () => {
    const darwin = host([], "/usr/local/bin", "darwin");
    expect(resolveCommand("npx", ["mocha"], darwin)).toEqual({
      file: "npx",
      args: ["mocha"],
    });
  });
});

describe("resolveCommand on win32", () => {
  it("passes commands other than npm and npx through unchanged", () => {
    const win = host(npmInstall(INSTALL_DIR), INSTALL_DIR);
    expect(resolveCommand(NODE_EXE, ["01_deploy.js"], win)).toEqual({
      file: NODE_EXE,
      args: ["01_deploy.js"],
    });
    expect(resolveCommand("git", ["status"], win)).toEqual({
      file: "git",
      args: ["status"],
    });
  });

  it("runs npm-cli.js from beside the npm.cmd on PATH through node", () => {
    const win = host(npmInstall(INSTALL_DIR), INSTALL_DIR);
    expect(resolveCommand("npm", ["audit"], win)).toEqual({
      file: NODE_EXE,
      args: [entry(INSTALL_DIR, "npm-cli.js"), "audit"],
    });
  });

  it("runs npx-cli.js for npx", () => {
    const win = host(npmInstall(INSTALL_DIR), INSTALL_DIR);
    expect(resolveCommand("npx", ["mocha"], win)).toEqual({
      file: NODE_EXE,
      args: [entry(INSTALL_DIR, "npx-cli.js"), "mocha"],
    });
  });

  it("uses the first npm.cmd on PATH when there are several", () => {
    const win = host(
      [...npmInstall("C:\\first"), ...npmInstall("C:\\second")],
      "C:\\second-without-npm;C:\\first;C:\\second",
    );
    expect(resolveCommand("npm", [], win).args).toEqual([
      entry("C:\\first", "npm-cli.js"),
    ]);
  });

  it("unquotes PATH entries and skips empty and relative ones", () => {
    // A relative entry would let the current directory - a user's project,
    // node_modules and all - stand in for npm.
    const win = host(
      [
        ...npmInstall("."),
        ...npmInstall(""),
        ...npmInstall("project"),
        ...npmInstall(INSTALL_DIR),
        ...npmInstall(NODE_DIR),
      ],
      `;.;project;"${INSTALL_DIR}";`,
    );
    expect(resolveCommand("npm", [], win).args).toEqual([
      entry(INSTALL_DIR, "npm-cli.js"),
    ]);
  });

  it("falls back to the running node's directory when no npm.cmd is on PATH", () => {
    const win = host(npmInstall(NODE_DIR), "C:\\Windows\\System32");
    expect(resolveCommand("npm", ["view"], win)).toEqual({
      file: NODE_EXE,
      args: [entry(NODE_DIR, "npm-cli.js"), "view"],
    });
  });

  it("falls back to node's directory, not a later npm.cmd, when the first has no entry script", () => {
    // A shim directory (Scoop, Volta) can hold npm.cmd without npm beside it.
    const win = host(
      [
        join("C:\\shims", "npm.cmd"),
        ...npmInstall(INSTALL_DIR),
        ...npmInstall(NODE_DIR),
      ],
      `C:\\shims;${INSTALL_DIR}`,
    );
    expect(resolveCommand("npm", [], win).args).toEqual([
      entry(NODE_DIR, "npm-cli.js"),
    ]);
  });

  it("falls back to node's directory when PATH is unset", () => {
    const win = host(npmInstall(NODE_DIR), undefined);
    expect(resolveCommand("npx", [], win).args).toEqual([
      entry(NODE_DIR, "npx-cli.js"),
    ]);
  });

  it("names both places it searched when neither has the entry script", () => {
    const win = host([join("C:\\shims", "npm.cmd")], "C:\\shims");
    const resolve = () => resolveCommand("npm", [], win);

    expect(resolve).toThrow(NpmEntryNotFoundError);
    expect(resolve).toThrow(path.win32.dirname(entry("C:\\shims", "x")));
    expect(resolve).toThrow(path.win32.dirname(entry(NODE_DIR, "x")));
  });

  it("says there is no npm.cmd on PATH when that is why the first place is missing", () => {
    const win = host([], "C:\\Windows\\System32");
    const resolve = () => resolveCommand("npx", [], win);

    expect(resolve).toThrow(NpmEntryNotFoundError);
    expect(resolve).toThrow("no npm.cmd on PATH");
    expect(resolve).toThrow(path.win32.dirname(entry(NODE_DIR, "x")));
  });

  it("hands every argument on as its own element, without touching the input", () => {
    const win = host(npmInstall(INSTALL_DIR), INSTALL_DIR);
    const args = [...ODD_ARGS];

    const resolved = resolveCommand("npm", args, win);

    expect(resolved.args).toEqual([
      entry(INSTALL_DIR, "npm-cli.js"),
      ...ODD_ARGS,
    ]);
    expect(args).toEqual(ODD_ARGS);
  });
});

describe("currentHost", () => {
  it("describes the running process", () => {
    const current = currentHost();
    expect(current.platform).toBe(process.platform);
    expect(current.pathEnv).toBe(process.env.PATH);
    expect(current.execPath).toBe(process.execPath);
    expect(current.exists(process.execPath)).toBe(true);
  });
});
