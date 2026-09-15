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
  validatePasswordStrength,
  writeSessionFile,
  type SessionData,
} from "../../src/utils/session";

const PASSWORD = "correct horse";
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

  it("prefers the PRIVATE_KEY env var over the encrypted session file", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-session"),
      JSON.stringify(makeSession()),
    );
    process.env.PRIVATE_KEY = "0xenv";

    const { getDynamicNetwork } = await import("../../src/utils/network");
    const network = await getDynamicNetwork("local");

    expect(network.privateKey).toBe("0xenv");
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

    expect(network.privateKey).toBeUndefined();
    expect(network.url).toBe("http://127.0.0.1:1");
  });
});
