import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import {
  decryptSessionKey,
  encryptSessionKey,
  LEGACY_PBKDF2_ITERATIONS,
} from "../../src/utils/session";
import {
  PASSWORD,
  KEY,
  useRealPbkdf2,
  output,
  clearLogged,
  readSession,
  writeSession,
  KEY_B,
  ADDRESS_A,
  ADDRESS_B,
  walletsFile,
  readWallets,
  sessionFile,
  writeKeySession,
  writeCbcSession,
  writeBrokenSession,
  expectNoKeyLeak,
  expectNoSessionFileLeak,
  setUp,
  tearDown,
} from "../helpers/walletEnv";
import { walletCommands, save, use } from "../helpers/walletSut";

beforeEach(setUp);
afterEach(tearDown);

describe("wallet save / list", () => {
  it("saves an encrypted entry and lists it by name and address", async () => {
    useRealPbkdf2();
    await save("deployer");

    const file = readWallets();
    expect(file.version).toBe(1);
    expect(file.wallets).toHaveLength(1);
    const [entry] = file.wallets;
    expect(entry.name).toBe("deployer");
    expect(entry.address).toBe(ADDRESS_A);
    expect(entry.iterations).toBe(600000);
    expect(decryptSessionKey(PASSWORD, entry)).toBe(KEY);

    clearLogged();
    const { runWalletList } = await walletCommands();
    await runWalletList();
    expect(output()).toContain("deployer");
    expect(output()).toContain(ADDRESS_A);
    expect(output()).not.toContain("[*]");
    expectNoKeyLeak();
  });

  it("says so when nothing is saved, without creating the file", async () => {
    const { runWalletList } = await walletCommands();
    await runWalletList();

    expect(output()).toContain("No saved wallets.");
    expect(fs.existsSync(walletsFile())).toBe(false);
  });

  it("refuses a name that is already saved, before prompting", async () => {
    await save("deployer");
    const before = fs.readFileSync(walletsFile(), "utf8");

    const { runWalletSave } = await walletCommands();
    await expect(runWalletSave("deployer")).rejects.toThrow(
      "wallet 'deployer' is already saved",
    );
    expect(fs.readFileSync(walletsFile(), "utf8")).toBe(before);
  });

  it.each(["", "Deployer", "-x", "__proto__", "a b", "x".repeat(33)])(
    "refuses the invalid name %j before prompting",
    async (name) => {
      const { runWalletSave } = await walletCommands();
      await expect(runWalletSave(name)).rejects.toThrow("invalid wallet name");
      expect(fs.existsSync(walletsFile())).toBe(false);
    },
  );

  it("warns when the same key is saved under a second name, and saves it", async () => {
    await save("one");
    clearLogged();
    await save("two");

    expect(output()).toContain("warning:");
    expect(output()).toContain("already saved as 'one'");
    expect(readWallets().wallets.map((w) => w.name)).toEqual(["one", "two"]);
  });

  it("writes nothing when the password confirmation does not match", async () => {
    await expect(
      save("deployer", KEY, PASSWORD, "correct horse 8"),
    ).rejects.toThrow("passwords do not match");
    expect(fs.existsSync(walletsFile())).toBe(false);

    await save("other", KEY_B);
    const before = fs.readFileSync(walletsFile(), "utf8");
    await expect(save("deployer", KEY, PASSWORD, "nope")).rejects.toThrow(
      "passwords do not match",
    );
    expect(fs.readFileSync(walletsFile(), "utf8")).toBe(before);
    expectNoKeyLeak();
  });
});

// #182: the way out before a session is replaced. A `create --login` key was
// never printed, so plain `wallet save` (which asks for the key) cannot keep it.
describe("wallet save --session", () => {
  /** Saves the session key with no prompt available and no terminal. */
  async function saveSession(name: string): Promise<void> {
    process.stdin.isTTY = false;
    const { runWalletSave } = await walletCommands();
    await runWalletSave(name, { session: true });
  }

  it("copies the session key into the store, openable with the session password", async () => {
    const session = writeKeySession(ADDRESS_B);

    await saveSession("keep");

    const [entry] = readWallets().wallets;
    expect(entry).toMatchObject({ name: "keep", address: ADDRESS_B });
    expect(decryptSessionKey(PASSWORD, entry)).toBe(KEY_B);
    expect(fs.readFileSync(sessionFile(), "utf8")).toBe(session);
    expect(output()).toContain(
      `Saved wallet 'keep' (${ADDRESS_B}) from .cmu-session.`,
    );
    expect(output()).toContain("session's password");
    expect(output()).not.toContain(entry.encryptedKey as string);

    process.stdin.isTTY = true;
    await save("deployer");
    await use("deployer");
    await use("keep");
    expect(readSession().address).toBe(ADDRESS_B);
    expect(decryptSessionKey(PASSWORD, readSession())).toBe(KEY_B);
    expectNoKeyLeak();
  });

  it("keeps a session from before the iterations field openable", async () => {
    writeKeySession(ADDRESS_B, KEY_B, {
      ...encryptSessionKey(PASSWORD, KEY_B, LEGACY_PBKDF2_ITERATIONS),
      iterations: undefined,
    });

    await saveSession("old");

    const [entry] = readWallets().wallets;
    expect(entry.iterations).toBe(LEGACY_PBKDF2_ITERATIONS);
    expect(decryptSessionKey(PASSWORD, entry)).toBe(KEY_B);
  });

  it.each([
    ["there is no session", () => {}, "holds no key to save"],
    ["the session holds no key", () => writeSession("local"), "holds no key"],
  ])("refuses when %s", async (_, setup, message) => {
    setup();
    await expect(saveSession("keep")).rejects.toThrow(message);
    expect(fs.existsSync(walletsFile())).toBe(false);
  });

  // #209: both used to read as "holds no key" or a raw JSON error, although
  // each file can still hold a recoverable key.
  it("refuses a session from cmu 1.3.1, naming what it holds", async () => {
    writeCbcSession();

    await expect(saveSession("keep")).rejects.toThrow(
      `this project's .cmu-session holds an encrypted key for ${ADDRESS_B} that this version of cmu cannot open or save (written by cmu 1.3.1 or older, or incomplete).`,
    );
    expect(fs.existsSync(walletsFile())).toBe(false);
  });

  it("refuses an unparseable session without quoting it", async () => {
    const before = writeBrokenSession();
    const { fail } = await import("../../src/utils/errors");
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await saveSession("keep").catch(fail("wallet save", { verbose: true }));

    expect(output()).toContain(
      ".cmu-session is not valid JSON, so cmu cannot read a key from it.",
    );
    expect(fs.existsSync(walletsFile())).toBe(false);
    expect(fs.readFileSync(sessionFile(), "utf8")).toBe(before);
    expectNoSessionFileLeak(before);
  });

  it.each([
    ["the name is taken", "keep", "already saved"],
    ["the key is already saved", "other", "already saved as 'keep'"],
  ])("refuses when %s, store unchanged", async (_, name, message) => {
    await save("keep", KEY_B);
    writeKeySession(ADDRESS_B);
    const store = fs.readFileSync(walletsFile(), "utf8");

    await expect(saveSession(name)).rejects.toThrow(message);
    expect(fs.readFileSync(walletsFile(), "utf8")).toBe(store);
  });
});
