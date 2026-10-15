import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { decryptSessionKey } from "../../src/utils/session";
import {
  PASSWORD,
  KEY_B,
  ADDRESS_B,
  tmpDir,
  output,
  clearLogged,
  readSession,
  writeSession,
  sessionFile,
  writeKeySession,
  writeCbcSession,
  writeBrokenSession,
  expectNoKeyLeak,
  expectNoSessionFileLeak,
  setUp,
  tearDown,
} from "../helpers/walletEnv";
import { askingCommands, asked, ctrlC, save } from "../helpers/walletSut";

beforeEach(setUp);
afterEach(tearDown);

const BACKUP_PREFIX = ".cmu-session.bak-";
// toISOString() with ":" and "." made safe for a Windows file name.
const BACKUP_NAME =
  /^\.cmu-session\.bak-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const OWNER_ONLY = 0o600;
const PERMISSION_BITS = 0o777;
const FIXED_NOW = new Date("2026-10-15T12:34:56.789Z");

/** The backups `use` left next to the session. */
function backups(): string[] {
  return fs.readdirSync(tmpDir).filter((n) => n.startsWith(BACKUP_PREFIX));
}

/** Runs `wallet use deployer` with prompts answered by name. */
async function runUse(answers: Record<string, unknown>): Promise<void> {
  return (await askingCommands(answers)).runWalletUse("deployer");
}

/** Makes any session write fail the test loudly, and returns the spy. */
function blockSessionWrites() {
  const write = vi.fn(async () => {
    throw new Error("writeSessionFile must not be called");
  });
  vi.doMock("../../src/utils/session", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/utils/session")>()),
    writeSessionFile: write,
  }));
  return write;
}

/** The session was left byte-identical, with no backup and no temp file. */
function expectUntouched(before: string): void {
  expect(fs.readFileSync(sessionFile(), "utf8")).toBe(before);
  expect(backups()).toEqual([]);
  expectNoKeyLeak();
}

/** A stray comma after a value, the issue's hand edit. */
function writeStrayCommaSession(): string {
  const text = writeKeySession(ADDRESS_B).replace(
    '"activeNetwork": "local",',
    '"activeNetwork": "local",,',
  );
  fs.writeFileSync(sessionFile(), text);
  return text;
}

const UNOPENABLE = `holds an encrypted key for ${ADDRESS_B} that this version of cmu cannot open`;
const UNREADABLE = ".cmu-session is not valid JSON";

// #209: #182's check let two files through as "nothing to lose" although the
// key in them could still be recovered: a session from cmu 1.3.1 or older
// (AES-256-CBC, no authTag) and one whose JSON no longer parses. `use` must
// ask first, refuse without a terminal, and keep a copy before replacing.
describe.each([
  ["from cmu 1.3.1 (AES-CBC)", () => writeCbcSession(), UNOPENABLE],
  [
    "missing its salt and iv",
    () => writeKeySession(ADDRESS_B, KEY_B, { salt: undefined, iv: undefined }),
    UNOPENABLE,
  ],
  ["with a stray comma", writeStrayCommaSession, UNREADABLE],
  ["with a typo before its encryptedKey", writeBrokenSession, UNREADABLE],
])("wallet use over a session %s", (_, writeOld, warning) => {
  beforeEach(async () => {
    await save("deployer"); // KEY, the key use writes
    clearLogged();
  });

  it("asks first, then keeps an owner-only copy and replaces it", async () => {
    const before = writeOld();

    await runUse({ replace: true, password: PASSWORD });

    expect(asked).toEqual(["replace", "password"]);
    expect(output()).toContain(warning);
    const names = backups();
    expect(names).toHaveLength(1);
    const [backup] = names;
    expect(backup).toMatch(BACKUP_NAME);
    const backupPath = path.join(tmpDir, backup);
    expect(fs.readFileSync(backupPath, "utf8")).toBe(before);
    if (process.platform !== "win32") {
      expect(fs.statSync(backupPath).mode & PERMISSION_BITS).toBe(OWNER_ONLY);
    }
    expect(output()).toContain(`Kept the old session as ${backup}`);
    expect(output()).toContain("`.cmu-session.bak-*`");
    const session = readSession();
    expect(session.address).not.toBe(ADDRESS_B);
    expectNoKeyLeak([decryptSessionKey(PASSWORD, session)]);
    expectNoSessionFileLeak(before);
  });

  it.each([
    ["no", false, "aborted: .cmu-session was not changed"],
    ["Ctrl-C", ctrlC(), "force closed the prompt"],
  ])(
    "leaves it untouched on %s, without asking for a password",
    async (__, replace, message) => {
      const before = writeOld();
      const write = blockSessionWrites();

      await expect(runUse({ replace, password: PASSWORD })).rejects.toThrow(
        message,
      );

      expect(asked).toEqual(["replace"]);
      expect(write).not.toHaveBeenCalled();
      expectUntouched(before);
      expectNoSessionFileLeak(before);
    },
  );

  it("refuses without a terminal, before any prompt", async () => {
    const before = writeOld();
    const write = blockSessionWrites();
    process.stdin.isTTY = false;

    const error = await runUse({ password: PASSWORD }).catch((e: Error) => e);

    expect((error as Error).message).toContain(
      "cannot prompt for confirmation in a non-interactive session",
    );
    expect((error as Error).message).toContain(
      "move .cmu-session somewhere safe",
    );
    expect(output()).toContain(warning);
    expect(asked).toEqual([]);
    expect(write).not.toHaveBeenCalled();
    expectUntouched(before);
    expectNoSessionFileLeak(before);
  });

  it("keeps no copy and changes nothing on a wrong password", async () => {
    const before = writeOld();

    await expect(
      runUse({ replace: true, password: "wrong password 1" }),
    ).rejects.toThrow("wrong password for wallet 'deployer'");

    expect(asked).toEqual(["replace", "password"]);
    expectUntouched(before);
  });

  it("does not quote the file through --verbose after a refusal", async () => {
    const before = writeOld();
    const { fail } = await import("../../src/utils/errors");
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await runUse({ replace: false }).catch(
      fail("wallet use", { verbose: true }),
    );

    expect(output()).toContain("wallet use failed");
    expectUntouched(before);
    expectNoSessionFileLeak(before);
  });
});

describe("wallet use over a session that provably holds no key", () => {
  beforeEach(async () => {
    await save("deployer");
    clearLogged();
  });

  it.each([
    ["an empty file", () => fs.writeFileSync(sessionFile(), "")],
    ["a blank file", () => fs.writeFileSync(sessionFile(), "  \n")],
    ["JSON null", () => fs.writeFileSync(sessionFile(), "null")],
    ["a network-only session", () => writeSession("local")],
    [
      "a 1.3.1 session whose address is a saved wallet",
      async () => {
        writeCbcSession();
        await save("b", KEY_B);
      },
    ],
  ])("replaces %s without asking or a copy", async (_, setup) => {
    await setup();

    // No `replace` answer: asking would throw, and the error is kept so the
    // prompts asked are what fails.
    const error = await runUse({ password: PASSWORD }).catch((e: Error) => e);

    expect(asked).toEqual(["password"]);
    expect(error).toBeUndefined();
    expect(backups()).toEqual([]);
    expect(readSession().address).not.toBe(ADDRESS_B);
  });
});

describe("wallet use, when the backup name is taken", () => {
  afterEach(() => vi.useRealTimers());

  it("refuses and leaves both files alone", async () => {
    await save("deployer");
    const before = writeCbcSession();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
    const taken = path.join(
      tmpDir,
      `${BACKUP_PREFIX}${FIXED_NOW.toISOString().replace(/[:.]/g, "-")}`,
    );
    fs.writeFileSync(taken, "earlier backup");

    await expect(runUse({ replace: true, password: PASSWORD })).rejects.toThrow(
      "EEXIST",
    );

    expect(fs.readFileSync(sessionFile(), "utf8")).toBe(before);
    expect(fs.readFileSync(taken, "utf8")).toBe("earlier backup");
  });
});
