import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// Errors as Node raises them, captured from real runs: an executable missing
// on Linux, and Windows refusing npm.cmd without a shell (which does not name
// the tool at all).
function spawnError(
  message: string,
  fields: Record<string, unknown>,
): NodeJS.ErrnoException {
  return Object.assign(new Error(message), fields);
}

const NPM_ENOENT = spawnError("spawn npm ENOENT", {
  errno: -2,
  code: "ENOENT",
  syscall: "spawn npm",
  path: "npm",
  spawnargs: ["audit"],
});

const NPX_ENOENT = spawnError("spawn npx ENOENT", {
  errno: -2,
  code: "ENOENT",
  syscall: "spawn npx",
  path: "npx",
  spawnargs: ["solhint", "contracts/**/*.sol"],
});

const WIN32_EINVAL = spawnError("spawn EINVAL", {
  errno: -4071,
  code: "EINVAL",
  syscall: "spawn",
});

const AUDIT_COMPLETE = "Audit complete.";

/** Everything a console spy was called with, as one string. */
function printed(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.flat().join("\n");
}

describe("runAudit", () => {
  let run: ReturnType<typeof vi.fn>;
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let exec: typeof import("../../src/utils/exec");
  let audit: typeof import("../../src/commands/audit");

  beforeEach(async () => {
    vi.resetModules();
    run = vi.fn(async () => {});
    vi.doMock("../../src/utils/exec", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/utils/exec")>()),
      run,
    }));
    exec = await import("../../src/utils/exec");
    audit = await import("../../src/commands/audit");
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../../src/utils/exec");
    vi.resetModules();
  });

  it("fails, naming npm and the cause, when npm cannot be found", async () => {
    run.mockRejectedValueOnce(NPM_ENOENT);

    await expect(audit.runAudit({})).rejects.toThrow(
      "npm could not be started: spawn npm ENOENT",
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(printed(log)).not.toContain(AUDIT_COMPLETE);
  });

  it("names npm when Windows refuses to spawn it", async () => {
    run.mockRejectedValueOnce(WIN32_EINVAL);

    await expect(audit.runAudit({})).rejects.toThrow(
      "npm could not be started: spawn EINVAL",
    );
    expect(printed(log)).not.toContain(AUDIT_COMPLETE);
  });

  it("passes on where the resolver looked when npm's entry script is missing", async () => {
    const { NpmEntryNotFoundError } =
      await import("../../src/utils/npmCommand");
    run.mockRejectedValueOnce(
      new NpmEntryNotFoundError("npm-cli.js", ["C:\\a", "C:\\b"]),
    );

    await expect(audit.runAudit({})).rejects.toThrow(
      "npm could not be started: cannot find npm-cli.js: searched C:\\a, then C:\\b",
    );
  });

  it("fails, naming npx, when npx cannot start after npm audit ran", async () => {
    run.mockResolvedValueOnce(undefined).mockRejectedValueOnce(NPX_ENOENT);

    await expect(audit.runAudit({})).rejects.toThrow(
      "npx could not be started: spawn npx ENOENT",
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(printed(log)).not.toContain(AUDIT_COMPLETE);
  });

  it("keeps npm audit findings a warning and still runs solhint", async () => {
    run.mockRejectedValueOnce(new exec.CommandExitError("npm", 1));

    await expect(audit.runAudit({})).resolves.toBeUndefined();
    expect(printed(warn)).toContain(
      "npm audit reported issues in the dependency tree.",
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(printed(log)).toContain(AUDIT_COMPLETE);
  });

  it("keeps solhint findings a warning", async () => {
    run
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new exec.CommandExitError("npx", 1));

    await expect(audit.runAudit({})).resolves.toBeUndefined();
    expect(printed(warn)).toContain(
      "solhint reported issues in the Solidity sources.",
    );
    expect(printed(log)).toContain(AUDIT_COMPLETE);
  });

  it("exits 1 through the command when a tool cannot start", async () => {
    run.mockRejectedValueOnce(NPM_ENOENT);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`exited ${code}`);
      });

    await expect(
      audit.auditCommand.parseAsync([], { from: "user" }),
    ).rejects.toThrow("exited 1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(printed(error)).toContain("audit failed");
    expect(printed(error)).toContain("npm could not be started");
    expect(printed(log)).not.toContain(AUDIT_COMPLETE);
  });
});

// Windows would still find npm beside the running node, so an empty PATH only
// leaves npm unreachable elsewhere.
const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("runAudit, really spawning", () => {
  let emptyDir: string;

  beforeEach(() => {
    vi.resetModules();
    emptyDir = mkdtempSync(path.join(tmpdir(), "cmu-no-npm-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("fails when npm is not on PATH", async () => {
    vi.stubEnv("PATH", emptyDir);
    const { runAudit } = await import("../../src/commands/audit");

    await expect(runAudit({})).rejects.toThrow(
      "npm could not be started: spawn npm ENOENT",
    );
  });
});
