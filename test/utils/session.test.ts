import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import {
  clearCachedKey,
  decryptSessionKey,
  DEFAULT_PBKDF2_ITERATIONS,
  encryptSessionKey,
  LEGACY_PBKDF2_ITERATIONS,
  readSession,
  validatePasswordStrength,
  writeSessionFile,
  type SessionData,
} from "../../src/utils/session";

const PASSWORD = "correct horse";
// well-known Ganache test key — never fund this
const PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    address: "0xTest",
    activeNetwork: "local",
    ...encryptSessionKey(PASSWORD, PRIVATE_KEY),
    ...overrides,
  };
}

describe("decryptSessionKey", () => {
  it("round-trips an encrypted private key", () => {
    expect(decryptSessionKey(PASSWORD, makeSession())).toBe(PRIVATE_KEY);
  });

  it("throws a clear error on the wrong password", () => {
    expect(() => decryptSessionKey("wrong password", makeSession())).toThrow(
      /Invalid session password/,
    );
  });

  it("throws a clear error when the ciphertext was tampered with", () => {
    const session = makeSession();
    session.encryptedKey = "00" + session.encryptedKey!.slice(2);
    expect(() => decryptSessionKey(PASSWORD, session)).toThrow(
      /Invalid session password/,
    );
  });

  it("points the user at re-login when a session cannot be unlocked", () => {
    expect(() => decryptSessionKey("wrong password", makeSession())).toThrow(
      /cmu wallet login/,
    );
  });

  it("stamps new sessions with the current PBKDF2 work factor", () => {
    expect(encryptSessionKey(PASSWORD, PRIVATE_KEY).iterations).toBe(
      DEFAULT_PBKDF2_ITERATIONS,
    );
    expect(DEFAULT_PBKDF2_ITERATIONS).toBeGreaterThan(LEGACY_PBKDF2_ITERATIONS);
  });

  it("still decrypts a legacy session that predates the iterations field", () => {
    const legacy: SessionData = {
      address: "0xTest",
      activeNetwork: "local",
      ...encryptSessionKey(PASSWORD, PRIVATE_KEY, LEGACY_PBKDF2_ITERATIONS),
    };
    delete legacy.iterations; // old files never wrote this key
    expect(decryptSessionKey(PASSWORD, legacy)).toBe(PRIVATE_KEY);
  });
});

describe("validatePasswordStrength", () => {
  it("rejects passwords below the minimum length", () => {
    expect(validatePasswordStrength("aB3xy")).toMatch(/at least/);
  });

  it("rejects a single character class even when long enough", () => {
    expect(validatePasswordStrength("aaaaaaaaaaaaaa")).toMatch(/mix at least/);
  });

  it("rejects well-known weak passwords", () => {
    expect(validatePasswordStrength("password1234")).toMatch(/too common/);
  });

  it("accepts a sufficiently strong password", () => {
    expect(validatePasswordStrength("correct horse 9")).toBe(true);
  });
});

describe("writeSessionFile", () => {
  it("writes the session file with owner-only permissions", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-perm-"));
    const file = path.join(dir, ".cmu-session");
    try {
      // Pre-create it world-readable to prove chmod tightens an existing file.
      fs.writeFileSync(file, "{}", { mode: 0o644 });
      await writeSessionFile(file, {
        address: "0xTest",
        activeNetwork: "local",
        ...encryptSessionKey(PASSWORD, PRIVATE_KEY),
      });
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
    // The distinction every caller but `wallet login` depends on: "no session"
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
