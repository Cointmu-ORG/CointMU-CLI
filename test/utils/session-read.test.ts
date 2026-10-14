import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import {
  clearCachedKey,
  readSession,
  requireSession,
  writeSessionFile,
} from "../../src/utils/session";
import { makeSession } from "../helpers/sessionEnv";

describe("readSession", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-read-session-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the project has no session at all", async () => {
    expect(await readSession()).toBeNull();
  });

  it("parses the session file the commands read", async () => {
    const session = makeSession();
    await writeSessionFile(path.join(tmpDir, ".cmu-session"), session);

    expect(await readSession()).toEqual(session);
  });

  it("throws on a corrupt session rather than passing it off as absent", async () => {
    // The distinction every caller but `wallet use` depends on: "no session"
    // is a state with a hint, an unreadable one is a fault worth surfacing.
    fs.writeFileSync(path.join(tmpDir, ".cmu-session"), "{ not json");

    await expect(readSession()).rejects.toThrow();
  });

  it("follows the working directory rather than caching the first path", async () => {
    await writeSessionFile(path.join(tmpDir, ".cmu-session"), makeSession());
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-elsewhere-"));
    try {
      vi.spyOn(process, "cwd").mockReturnValue(elsewhere);
      expect(await readSession()).toBeNull();
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

// wallet balance/info, mine start/stop, network use and activeNetwork() each
// turned a null readSession() into the same error by hand.
describe("requireSession", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-require-session-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the session when there is one", async () => {
    const session = makeSession();
    await writeSessionFile(path.join(tmpDir, ".cmu-session"), session);

    expect(await requireSession()).toEqual(session);
  });

  it("turns a missing session into an error that points at named wallets", async () => {
    const error = await requireSession().catch((e: Error) => e);
    expect((error as Error).message).toMatch(/^no active session\.\n.*hint:/);
    // `create --save` does not activate the wallet, so it never stands alone.
    expect((error as Error).message).toContain("`cmu wallet use <name>`");
    expect((error as Error).message).toContain(
      "`cmu wallet create --save <name>` and then `cmu wallet use <name>`",
    );
    expect((error as Error).message).not.toContain("login");
  });

  it("carries the caller's hint instead, when given one", async () => {
    await expect(requireSession("pass a network name.")).rejects.toThrow(
      /hint:.*pass a network name\.$/,
    );
  });

  it("still throws on a corrupt session rather than calling it missing", async () => {
    fs.writeFileSync(path.join(tmpDir, ".cmu-session"), "{ not json");

    await expect(requireSession()).rejects.toThrow(SyntaxError);
  });
});

describe("getDynamicNetwork", () => {
  let tmpDir: string;
  const prevKey = process.env.PRIVATE_KEY;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-session-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    vi.doMock("../../src/utils/networkStorage", () => ({
      loadNetworks: async () => [
        { name: "local", rpcUrl: "http://127.0.0.1:1" },
      ],
    }));
    // Fail loudly if a password prompt is triggered when it should not be.
    vi.doMock("inquirer", () => ({
      default: {
        prompt: async () => {
          throw new Error("inquirer.prompt should not be called");
        },
      },
    }));
    clearCachedKey();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.PRIVATE_KEY;
    else process.env.PRIVATE_KEY = prevKey;
  });

  it("returns the saved entry and nothing else - no key field at all", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-session"),
      JSON.stringify(makeSession()),
    );
    process.env.PRIVATE_KEY = "0xenv";

    const { getDynamicNetwork } = await import("../../src/utils/network");
    const network = await getDynamicNetwork("local");

    // toEqual, not a per-field check: it is what pins that no key reaches the
    // callers of this function, whatever PRIVATE_KEY happens to hold.
    expect(network).toEqual({ name: "local", rpcUrl: "http://127.0.0.1:1" });
  });

  it("does not prompt for a password when a key-bearing session exists but no env var is set", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-session"),
      JSON.stringify(makeSession()),
    );
    delete process.env.PRIVATE_KEY;

    const { getDynamicNetwork } = await import("../../src/utils/network");
    // inquirer.prompt is mocked to throw; this resolving proves no prompt fired.
    const network = await getDynamicNetwork("local");

    expect(network).toEqual({ name: "local", rpcUrl: "http://127.0.0.1:1" });
  });
});
