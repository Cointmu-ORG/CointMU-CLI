import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedCommand } from "../../src/utils/npmCommand";

// Errors as execFileSync and spawnSync raise them, captured from real runs: npm
// missing on Linux, Windows refusing npm.cmd without a shell, and npm starting
// but exiting non-zero.
function childError(
  message: string,
  fields: Record<string, unknown>,
): NodeJS.ErrnoException {
  return Object.assign(new Error(message), fields);
}

const VIEW_ENOENT = childError("spawnSync npm ENOENT", {
  errno: -2,
  code: "ENOENT",
  syscall: "spawnSync npm",
  path: "npm",
  spawnargs: ["view", "cointmu-cli@1.0.0", "version"],
  status: null,
  signal: null,
});

const VIEW_EINVAL = childError("spawnSync npm.cmd EINVAL", {
  errno: -4071,
  code: "EINVAL",
  syscall: "spawnSync npm.cmd",
  path: "npm.cmd",
  spawnargs: ["view", "cointmu-cli@1.0.0", "version"],
  status: null,
  signal: null,
});

const VIEW_E404 = childError(
  "Command failed: npm view cointmu-cli@99.0.0 version\nnpm error code E404",
  { status: 1, signal: null },
);

const INSTALL_ENOENT = childError("spawnSync npm ENOENT", {
  errno: -2,
  code: "ENOENT",
  syscall: "spawnSync npm",
  path: "npm",
  spawnargs: ["install", "-g", "cointmu-cli@1.0.0"],
});

const NODE_EXE = "C:\\node\\node.exe";
const NPM_CLI = "C:\\node\\node_modules\\npm\\bin\\npm-cli.js";

/** The resolver as it answers on Windows. */
function resolvedOnWindows(
  _command: string,
  args: readonly string[],
): ResolvedCommand {
  return { file: NODE_EXE, args: [NPM_CLI, ...args] };
}

/** The message of the error `promise` rejects with. */
async function rejection(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  return error instanceof Error ? error.message : `resolved: ${error}`;
}

describe("cmu update when npm cannot start", () => {
  let execFileSync: ReturnType<typeof vi.fn>;
  let spawnSync: ReturnType<typeof vi.fn>;
  let resolveCommand: ReturnType<typeof vi.fn> | undefined;

  /** update.ts over the mocks; the real resolver unless one is set. */
  async function loadUpdate() {
    vi.doMock("child_process", () => ({
      execFileSync,
      spawnSync,
      spawn: vi.fn(),
    }));
    if (resolveCommand) {
      vi.doMock("../../src/utils/npmCommand", async (importOriginal) => ({
        ...(await importOriginal<
          typeof import("../../src/utils/npmCommand")
        >()),
        resolveCommand,
      }));
    }
    return import("../../src/commands/update");
  }

  beforeEach(() => {
    vi.resetModules();
    execFileSync = vi.fn();
    spawnSync = vi.fn();
    resolveCommand = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("child_process");
    vi.doUnmock("../../src/utils/npmCommand");
    vi.resetModules();
  });

  it("names npm and the cause for --to, instead of blaming the registry", async () => {
    execFileSync.mockImplementation(() => {
      throw VIEW_ENOENT;
    });
    const { resolveTargetVersion } = await loadUpdate();

    const message = await rejection(resolveTargetVersion("1.0.0"));

    expect(message).toContain("npm could not be started: spawnSync npm ENOENT");
    expect(message).not.toContain("not available on the npm registry");
  });

  it("names npm when Windows refuses to spawn it", async () => {
    execFileSync.mockImplementation(() => {
      throw VIEW_EINVAL;
    });
    const { resolveTargetVersion } = await loadUpdate();

    const message = await rejection(resolveTargetVersion("1.0.0"));

    expect(message).toContain("npm could not be started");
    expect(message).toContain("EINVAL");
    expect(message).not.toContain("not available on the npm registry");
  });

  it("names npm and the cause without --to as well", async () => {
    execFileSync.mockImplementation(() => {
      throw VIEW_ENOENT;
    });
    const { resolveTargetVersion } = await loadUpdate();

    expect(await rejection(resolveTargetVersion())).toContain(
      "npm could not be started: spawnSync npm ENOENT",
    );
  });

  it("still reports a version npm could not find as not on the registry", async () => {
    execFileSync.mockImplementation(() => {
      throw VIEW_E404;
    });
    const { resolveTargetVersion } = await loadUpdate();

    expect(await rejection(resolveTargetVersion("99.0.0"))).toContain(
      'Version "99.0.0" is not available on the npm registry',
    );
  });

  it("passes on where the resolver looked when npm's entry script is missing", async () => {
    const { NpmEntryNotFoundError } =
      await import("../../src/utils/npmCommand");
    resolveCommand = vi.fn(() => {
      throw new NpmEntryNotFoundError("npm-cli.js", ["C:\\a", "C:\\b"]);
    });
    const { resolveTargetVersion } = await loadUpdate();

    const message = await rejection(resolveTargetVersion("1.0.0"));

    expect(message).toContain(
      "npm could not be started: cannot find npm-cli.js: searched C:\\a, then C:\\b",
    );
    expect(message).not.toContain("not available on the npm registry");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("asks the registry through the resolved npm", async () => {
    resolveCommand = vi.fn(resolvedOnWindows);
    execFileSync.mockReturnValue(Buffer.from("1.3.1\n"));
    const { resolveTargetVersion } = await loadUpdate();

    await expect(resolveTargetVersion("1.3.1")).resolves.toBe("1.3.1");
    expect(resolveCommand).toHaveBeenCalledWith("npm", [
      "view",
      "cointmu-cli@1.3.1",
      "version",
    ]);
    expect(execFileSync).toHaveBeenCalledWith(
      NODE_EXE,
      [NPM_CLI, "view", "cointmu-cli@1.3.1", "version"],
      { stdio: "pipe" },
    );
  });

  it("installs through the resolved npm", async () => {
    resolveCommand = vi.fn(resolvedOnWindows);
    execFileSync.mockReturnValue(Buffer.from("1.0.0\n"));
    spawnSync.mockReturnValue({ status: 0, stderr: Buffer.from("") });
    const { runUpdate } = await loadUpdate();

    await expect(runUpdate({ to: "1.0.0" })).resolves.toBeUndefined();
    expect(spawnSync).toHaveBeenCalledWith(
      NODE_EXE,
      [NPM_CLI, "install", "-g", "cointmu-cli@1.0.0"],
      expect.anything(),
    );
  });

  it("names npm and the cause when the install cannot start", async () => {
    execFileSync.mockReturnValue(Buffer.from("1.0.0\n"));
    spawnSync.mockReturnValue({
      error: INSTALL_ENOENT,
      status: null,
      stderr: null,
    });
    const { runUpdate } = await loadUpdate();

    expect(await rejection(runUpdate({ to: "1.0.0" }))).toContain(
      "npm could not be started: spawnSync npm ENOENT",
    );
  });
});
