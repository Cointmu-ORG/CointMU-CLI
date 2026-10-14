import { expect, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { stripVTControlCharacters } from "util";
import { encryptSessionKey, type SessionData } from "../../src/utils/session";

export const PASSWORD = "correct horse 9";
// Hardhat account #1, so the address in the assertions is a known value.
export const KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

export let tmpDir: string;
export let logged: string[];
/** Everything printed during the test; unlike `logged`, never reset midway. */
export let everything: string[];
export const realIsTTY = process.stdin.isTTY;

/**
 * PBKDF2 work factor for the keys these tests encrypt. At the real 600k,
 * every save, use and transfer setup spends most of a second deriving keys,
 * which dominated the suite. Decryption reads the factor stored with the
 * key, so only encryption needs it. The tests that pin the real default call
 * useRealPbkdf2() first.
 */
export const TEST_PBKDF2_ITERATIONS = 1000;

/** Undoes the cheap work factor for the next SUT import, for one test. */
export function useRealPbkdf2(): void {
  vi.doUnmock("../../src/utils/session");
}

/** Everything the command wrote to stdout and stderr, as one string. */
export function output(): string {
  return logged.join("\n");
}

/** Empties `logged`; importers cannot assign the binding themselves. */
export function clearLogged(): void {
  logged = [];
}

export function setUp(): void {
  // The SUT is imported after mockPrompt(), so it must not come from a cache
  // a previous test filled with the real inquirer.
  vi.resetModules();
  vi.doMock("../../src/utils/session", async (importOriginal) => {
    const real =
      await importOriginal<typeof import("../../src/utils/session")>();
    return {
      ...real,
      encryptSessionKey: (
        password: string,
        privateKey: string,
        iterations = TEST_PBKDF2_ITERATIONS,
      ) => real.encryptSessionKey(password, privateKey, iterations),
    };
  });
  // Prompts refuse to run without a TTY, and vitest's stdin usually is not one.
  process.stdin.isTTY = true;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-wallet-"));
  vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  logged = [];
  everything = [];
  const capture = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
    everything.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  // networkStorage keys .cmu-networks.json off os.homedir(); without this the
  // suite would read the developer's real saved networks.
  vi.stubEnv("HOME", tmpDir);
  vi.stubEnv("USERPROFILE", tmpDir);
}

export function tearDown(): void {
  process.stdin.isTTY = realIsTTY;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("inquirer");
  vi.doUnmock("../../src/utils/walletStorage");
  vi.doUnmock("../../src/utils/session");
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

/** Reads back the session the command under test wrote. */
export function readSession(): SessionData {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, ".cmu-session"), "utf8"));
}

/** Writes a session that already picked a network, as `network use` would. */
export function writeSession(activeNetwork: string): void {
  fs.writeFileSync(
    path.join(tmpDir, ".cmu-session"),
    JSON.stringify({ address: "0xTest", activeNetwork }),
  );
}

export function writeNetworks(names: string[]): void {
  fs.writeFileSync(
    path.join(tmpDir, ".cmu-networks.json"),
    JSON.stringify(
      names.map((name) => ({ name, rpcUrl: "http://127.0.0.1:9999" })),
    ),
  );
}

// Issue #177: named wallets in ~/.cmu-wallets.json. HOME and the cwd are both
// tmpDir (see beforeEach), so the store and the session sit side by side and
// the developer's real ~/.cmu-wallets.json is never read or written.

// Hardhat account #2: a second known key for the two-wallet cases.
export const KEY_B =
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
export const ADDRESS_A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const ADDRESS_B = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

export function walletsFile(): string {
  return path.join(tmpDir, ".cmu-wallets.json");
}

export function readWallets(): {
  version: number;
  wallets: Record<string, unknown>[];
} {
  return JSON.parse(fs.readFileSync(walletsFile(), "utf8"));
}

export function sessionFile(): string {
  return path.join(tmpDir, ".cmu-session");
}

/**
 * Writes a session holding `key`, as 1.5.x `login` or `create --login` left it:
 * encrypted with PASSWORD, and saved nowhere else unless a test does so.
 *
 * @param {string} address - The address the session names.
 * @param {string} [key] - The key to encrypt into it.
 * @param {Partial<SessionData>} [over] - Fields to replace or (as undefined) drop.
 * @returns {string} The file's exact contents, to compare against later.
 */
export function writeKeySession(
  address: string,
  key = KEY_B,
  over: Partial<SessionData> = {},
): string {
  const session = {
    address,
    activeNetwork: "local",
    ...encryptSessionKey(PASSWORD, key, TEST_PBKDF2_ITERATIONS),
    ...over,
  };
  const text = `${JSON.stringify(session, null, 2)}\n`;
  fs.writeFileSync(sessionFile(), text);
  return text;
}

/** Every file under dir, recursively. */
export function allFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * The private keys appear nowhere: not in anything printed during the test
 * (stdout or stderr, even before a `logged = []`), and not in any
 * file the commands left under tmpDir (HOME and cwd), with or without 0x.
 *
 * @param {string[]} [keys] - Further keys to look for, such as one the command
 *   generated itself.
 */
export function expectNoKeyLeak(keys: string[] = []): void {
  const files = allFiles(tmpDir);
  const haystacks = [
    everything.join("\n"),
    ...files.map((file) => fs.readFileSync(file, "utf8")),
  ].map((text) => text.toLowerCase());
  // With and without 0x, lowercased like the haystacks; and the password.
  const secrets = [KEY, KEY_B, ...keys].flatMap((key) => [
    key.toLowerCase(),
    key.slice(2).toLowerCase(),
  ]);
  secrets.push(PASSWORD.toLowerCase());
  for (const secret of secrets) {
    for (const text of haystacks) {
      expect(text).not.toContain(secret);
    }
  }
  expect(files.filter((file) => file.endsWith(".tmp"))).toEqual([]);
}

// #188: the hint that follows a wrong password depends on where the key came
// from. Neither may send the user to the removed `wallet login`.
export const SESSION_HINT =
  "hint: check the password. To start a fresh session, run `cmu wallet use <name>`.";
export const storeHint = (name: string) =>
  `hint: retype the password '${name}' was saved with - cmu cannot recover a forgotten one.`;

/** The last line of an error's message, where the hint goes, uncoloured. */
export function hintOf(error: unknown): string | undefined {
  return stripVTControlCharacters(String((error as Error)?.message))
    .split("\n")
    .at(-1);
}
