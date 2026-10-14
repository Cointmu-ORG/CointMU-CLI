import { describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import {
  decryptSessionKey,
  DEFAULT_PBKDF2_ITERATIONS,
  encryptSessionKey,
  LEGACY_PBKDF2_ITERATIONS,
  validatePasswordStrength,
  writeSessionFile,
  type SessionData,
} from "../../src/utils/session";
import { TEST_PBKDF2_ITERATIONS } from "../helpers/testPbkdf2";
import { PASSWORD, PRIVATE_KEY, makeSession } from "../helpers/sessionEnv";

describe("decryptSessionKey", () => {
  it("round-trips an encrypted private key", () => {
    // At the real work factor: the one full-cost round trip in this file.
    const session = makeSession({}, DEFAULT_PBKDF2_ITERATIONS);
    expect(decryptSessionKey(PASSWORD, session)).toBe(PRIVATE_KEY);
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

  // #188: `wallet login` needed the raw key and is removed (#194); a session
  // from `wallet use <name>` is recreated with `use`.
  it("points the user at the password, then `wallet use`, never `login`", () => {
    const error = (() => {
      try {
        decryptSessionKey("wrong password", makeSession());
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message.split("\n").at(-1)).toBe(
      "\x1b[2mhint:\x1b[0m check the password. To start a fresh session, run `cmu wallet use <name>`.",
    );
    expect(error?.message).not.toContain("wallet login");
  });

  it("stamps new sessions with the current PBKDF2 work factor", () => {
    expect(encryptSessionKey(PASSWORD, PRIVATE_KEY).iterations).toBe(
      DEFAULT_PBKDF2_ITERATIONS,
    );
    expect(DEFAULT_PBKDF2_ITERATIONS).toBeGreaterThan(LEGACY_PBKDF2_ITERATIONS);
    // Pinned as a literal: the fixtures above use a cheap factor, so this is
    // what fails if the production default is ever lowered or changed.
    expect(DEFAULT_PBKDF2_ITERATIONS).toBe(600000);
  });

  it("still decrypts a legacy session that predates the iterations field", () => {
    const legacy: SessionData = {
      address: "0xTest",
      activeNetwork: "local",
      ...encryptSessionKey(PASSWORD, PRIVATE_KEY, LEGACY_PBKDF2_ITERATIONS),
    };
    delete legacy.iterations; // old files never wrote this key
    expect(decryptSessionKey(PASSWORD, legacy)).toBe(PRIVATE_KEY);
    // Files written before the field existed used exactly this factor.
    expect(LEGACY_PBKDF2_ITERATIONS).toBe(100000);
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
        ...encryptSessionKey(PASSWORD, PRIVATE_KEY, TEST_PBKDF2_ITERATIONS),
      });
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // #182: a write cut off midway used to leave a truncated .cmu-session, and
  // with it the only copy of a key that was never saved.
  it("leaves the old session intact and no temp file when the write fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-atomic-"));
    const file = path.join(dir, ".cmu-session");
    try {
      fs.writeFileSync(file, "old session");
      // Imported after doMock and resetModules: the static import above holds
      // the real fs/promises.
      vi.resetModules();
      vi.doMock("fs/promises", async (importOriginal) => ({
        ...(await importOriginal<typeof import("fs/promises")>()),
        rename: async () => {
          throw new Error("disk full");
        },
      }));
      const session = await import("../../src/utils/session");

      await expect(
        session.writeSessionFile(file, makeSession()),
      ).rejects.toThrow("disk full");

      expect(fs.readFileSync(file, "utf8")).toBe("old session");
      expect(fs.readdirSync(dir)).toEqual([".cmu-session"]);
    } finally {
      vi.doUnmock("fs/promises");
      vi.resetModules();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
