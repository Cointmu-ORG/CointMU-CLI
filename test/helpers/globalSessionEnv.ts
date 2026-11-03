import { expect, vi } from "vitest";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// A global ~/.cmu-session with per-folder overrides: HOME and the working
// folder are separate directories here, unlike walletEnv.ts where they are
// one. Nothing under src/ is imported statically - fixtures are encrypted with
// node:crypto directly - so a missing or stubbed export fails a test with an
// assertion rather than the whole file at import.

export const PASSWORD = "correct horse 9";
// Hardhat accounts #1 and #2: known keys, so the addresses are known values.
export const KEY_A =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const ADDRESS_A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const KEY_B =
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
export const ADDRESS_B = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

export const SESSION_FILE = ".cmu-session";
/** Cheap work factor for fixtures; decryption reads it from the file. */
const FIXTURE_ITERATIONS = 1000;
/** What sessions without an `iterations` field were encrypted with. */
const LEGACY_ITERATIONS = 100000;
const SALT_BYTES = 16;
const GCM_IV_BYTES = 12;
const CBC_IV_BYTES = 16;
const KEY_BYTES = 32;
const JSON_SPACES = 2;

export interface Dirs {
  root: string;
  home: string;
  projectA: string;
  projectB: string;
}

export let dirs: Dirs;
/** Everything printed since setUp(), one entry per console call. */
export let printed: string[];
/** Every prompt the last SUT asked, by question name. */
export let asked: string[];
const realIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

/** Fresh HOME and two project folders; the working folder is projectA. */
export function setUp(): void {
  vi.resetModules();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-global-session-"));
  dirs = {
    root,
    home: path.join(root, "home"),
    projectA: path.join(root, "project-a"),
    projectB: path.join(root, "project-b"),
  };
  for (const dir of [dirs.home, dirs.projectA, dirs.projectB])
    fs.mkdirSync(dir);
  // os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
  vi.stubEnv("HOME", dirs.home);
  vi.stubEnv("USERPROFILE", dirs.home);
  vi.stubEnv("PRIVATE_KEY", "");
  cd(dirs.projectA);
  printed = [];
  asked = [];
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
  }
  // Set either way, so the suite passes whatever stdin vitest runs with.
  process.stdin.isTTY = true;
}

export function tearDown(): void {
  if (realIsTTY) Object.defineProperty(process.stdin, "isTTY", realIsTTY);
  else Reflect.deleteProperty(process.stdin, "isTTY");
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.doUnmock("inquirer");
  vi.resetModules();
  fs.rmSync(dirs.root, { recursive: true, force: true });
}

/** Makes `dir` the working folder, as `cd dir` would. */
export function cd(dir: string): void {
  vi.spyOn(process, "cwd").mockReturnValue(dir);
}

/** Everything printed, as one string with the colour codes left in. */
export function output(): string {
  return printed.join("\n");
}

export function sessionIn(dir: string): string {
  return path.join(dir, SESSION_FILE);
}

/** Every file in dir (not recursive), by name. */
export function filesIn(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}

interface EncryptedFields {
  encryptedKey: string;
  salt: string;
  iv: string;
  authTag: string;
  iterations: number;
}

/** AES-256-GCM under PBKDF2-SHA256, in the shape cmu stores keys. */
function encryptGcm(key: string, iterations: number): EncryptedFields {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const aesKey = crypto.pbkdf2Sync(
    PASSWORD,
    salt,
    iterations,
    KEY_BYTES,
    "sha256",
  );
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  const encryptedKey = cipher.update(key, "utf8", "hex") + cipher.final("hex");
  return {
    encryptedKey,
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    authTag: cipher.getAuthTag().toString("hex"),
    iterations,
  };
}

function writeJson(file: string, value: unknown): string {
  const text = `${JSON.stringify(value, null, JSON_SPACES)}\n`;
  fs.writeFileSync(file, text);
  return text;
}

/**
 * Writes a .cmu-session into `dir` holding `key`, encrypted with PASSWORD.
 *
 * @returns {string} The file's exact contents, to compare against later.
 */
export function writeSession(
  dir: string,
  address: string,
  key: string,
  activeNetwork = "local",
): string {
  return writeJson(sessionIn(dir), {
    address,
    activeNetwork,
    ...encryptGcm(key, FIXTURE_ITERATIONS),
  });
}

/**
 * A session as `wallet login` wrote it before the `iterations` field existed:
 * AES-GCM at the legacy 100k, with no iterations key.
 *
 * @returns {string} The file's exact contents.
 */
export function writeLegacyGcmSession(
  dir: string,
  address: string,
  key: string,
): string {
  const { encryptedKey, salt, iv, authTag } = encryptGcm(
    key,
    LEGACY_ITERATIONS,
  );
  return writeJson(sessionIn(dir), {
    address,
    activeNetwork: "local",
    encryptedKey,
    salt,
    iv,
    authTag,
  });
}

/**
 * A session as cmu 1.3.1 and older wrote it: AES-256-CBC, no authTag.
 *
 * @returns {string} The file's exact contents.
 */
export function writeCbcSession(
  dir: string,
  address: string,
  key: string,
): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(CBC_IV_BYTES);
  const aesKey = crypto.pbkdf2Sync(
    PASSWORD,
    salt,
    LEGACY_ITERATIONS,
    KEY_BYTES,
    "sha256",
  );
  const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, iv);
  return writeJson(sessionIn(dir), {
    address,
    activeNetwork: "local",
    encryptedKey: cipher.update(key, "utf8", "hex") + cipher.final("hex"),
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
  });
}

/** Saves wallets in ~/.cmu-wallets.json, each encrypted with PASSWORD. */
export function writeWallets(
  wallets: { name: string; address: string; key: string }[],
): void {
  writeJson(path.join(dirs.home, ".cmu-wallets.json"), {
    version: 1,
    wallets: wallets.map(({ name, address, key }) => ({
      name,
      address,
      ...encryptGcm(key, FIXTURE_ITERATIONS),
    })),
  });
}

/** Saves networks in ~/.cmu-networks.json, all pointing at a dead port. */
export function writeNetworks(names: string[]): void {
  writeJson(
    path.join(dirs.home, ".cmu-networks.json"),
    names.map((name) => ({ name, rpcUrl: "http://127.0.0.1:9" })),
  );
}

/**
 * A file's text, asserted to exist first: a file that was not written fails
 * the test as an assertion rather than as ENOENT.
 */
export function readText(file: string): string {
  expect(fs.existsSync(file), `${file} should exist`).toBe(true);
  return fs.readFileSync(file, "utf8");
}

export function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readText(file));
}

/** "done", or the message it failed with: an assertion, not a crash, either way. */
export async function outcome(run: Promise<void>): Promise<string> {
  return run.then(
    () => "done",
    (error: Error) => error.message,
  );
}

/** Mocks inquirer to answer by question name; an unexpected one throws. */
function mockPrompts(answers: Record<string, unknown>): void {
  asked = [];
  vi.doMock("inquirer", () => ({
    default: {
      prompt: async (batch: { name: string }[]) => {
        const result: Record<string, unknown> = {};
        for (const { name } of batch) {
          asked.push(name);
          if (!(name in answers))
            throw new Error(`unexpected prompt '${name}'`);
          result[name] = answers[name];
        }
        return result;
      },
    },
  }));
}

/** A fresh `wallet` command module whose prompts answer from `answers`. */
export async function walletSut(answers: Record<string, unknown> = {}) {
  vi.resetModules();
  mockPrompts(answers);
  return import("../../src/commands/wallet");
}

/** A fresh `wallet info` / `wallet balance` module; they prompt for nothing. */
export async function walletInfoSut() {
  vi.resetModules();
  mockPrompts({});
  return import("../../src/commands/wallet/info");
}

/** A fresh session module whose prompts answer from `answers`. */
export async function sessionSut(answers: Record<string, unknown> = {}) {
  vi.resetModules();
  mockPrompts(answers);
  return import("../../src/utils/session");
}

/** A fresh session-location module. */
export async function locationSut() {
  vi.resetModules();
  return import("../../src/utils/sessionLocation");
}

/**
 * Runs `cmu network <argv...>` the way the CLI would. A failure ends in
 * process.exit(1) there; here it rejects, so outcome() can report it.
 */
export async function runNetwork(...argv: string[]): Promise<void> {
  vi.resetModules();
  mockPrompts({});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
  const { networkCommand } = await import("../../src/commands/network");
  await networkCommand.parseAsync(argv, { from: "user" });
}
