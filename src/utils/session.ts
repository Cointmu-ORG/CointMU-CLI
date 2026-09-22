import * as crypto from "crypto";
import * as path from "path";
import { existsSync } from "fs";
import { chmod, readFile, writeFile } from "fs/promises";

const ALGORITHM = "aes-256-gcm";
const SESSION_FILE_NAME = ".cmu-session";
const SALT_BYTES = 16;
const IV_BYTES = 12; // 96-bit IV is the standard nonce size for AES-GCM
const KEY_LENGTH = 32;
const DIGEST = "sha256";
const JSON_SPACES = 2;

/** Owner read/write only. The session file holds an encrypted private key. */
const SESSION_FILE_MODE = 0o600;

/**
 * PBKDF2-HMAC-SHA256 work factor for new sessions. 600k is the OWASP 2023
 * floor for this digest. The value used is persisted in the session file
 * (`iterations`), so it can be raised again later without breaking sessions
 * written with a smaller factor.
 */
export const DEFAULT_PBKDF2_ITERATIONS = 600000;

/**
 * Work factor for sessions written before the `iterations` field existed.
 * Those files must keep decrypting; they simply used this fixed value.
 */
export const LEGACY_PBKDF2_ITERATIONS = 100000;

/** Minimum length for a new session password. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Absolute path to the session file in the current project.
 *
 * Resolved on every call rather than memoised at import time: the CLI reads it
 * relative to the working directory, and tests stub process.cwd().
 *
 * @returns {string} The absolute path to .cmu-session.
 */
export function getSessionFilePath(): string {
  return path.resolve(process.cwd(), SESSION_FILE_NAME);
}

const COMMON_WEAK_PASSWORDS = new Set([
  "password",
  "passw0rd",
  "password1234",
  "letmein12345",
  "123456789012",
  "qwertyuiop12",
  "administrator",
  "changeme1234",
]);

export interface SessionData {
  address: string;
  activeNetwork: string;
  encryptedKey?: string;
  salt?: string;
  iv?: string;
  authTag?: string;
  /** PBKDF2 iterations used for this session. Absent = legacy (100k). */
  iterations?: number;
}

export interface EncryptedKey {
  encryptedKey: string;
  salt: string;
  iv: string;
  authTag: string;
  iterations: number;
}

/**
 * The parsed .cmu-session of the current project, or null when there is none.
 *
 * The one read every caller shares: existsSync + readFile + JSON.parse used to
 * be copied into each command that needed the session. Malformed JSON still
 * throws rather than coming back as null - a session file that exists but
 * cannot be read is not the same thing as no session, and only `wallet login`
 * treats it as recoverable.
 *
 * @returns {Promise<SessionData | null>} The session, or null if absent.
 */
export async function readSession(): Promise<SessionData | null> {
  const sessionFile = getSessionFilePath();
  if (!existsSync(sessionFile)) return null;
  return JSON.parse(await readFile(sessionFile, "utf8"));
}

/**
 * Proportional strength check for a local CLI session password. Not a
 * passphrase-manager replacement: it only rejects the obviously weak
 * choices (too short, single character class, known common passwords).
 * Returns `true` when acceptable, or a message string for inquirer.
 */
export function validatePasswordStrength(password: string): true | string {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  }
  if (COMMON_WEAK_PASSWORDS.has(password.toLowerCase())) {
    return "password is too common - choose something less predictable.";
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) =>
    re.test(password),
  ).length;
  if (classes < 2) {
    return "password must mix at least two of: lowercase, uppercase, digits, symbols.";
  }
  return true;
}

/**
 * Persists session data with owner-only permissions (0600). chmod is applied
 * unconditionally so a file that already existed with looser permissions is
 * tightened on rewrite, not just on first creation.
 */
export async function writeSessionFile(
  filePath: string,
  data: SessionData,
): Promise<void> {
  // Trailing newline: what fs-extra's writeJson wrote, and what every other
  // tool expects of a text file.
  await writeFile(filePath, `${JSON.stringify(data, null, JSON_SPACES)}\n`, {
    mode: SESSION_FILE_MODE,
  });
  await chmod(filePath, SESSION_FILE_MODE);
}

/** In-memory cache of the decrypted key for the lifetime of one CLI process. */
let cachedKey: string | undefined;

/** Resets the in-memory decrypted-key cache. Exposed for tests. */
export function clearCachedKey(): void {
  cachedKey = undefined;
}

/** Derives the AES key from a password + salt using PBKDF2-HMAC-SHA256. */
function deriveKey(password: string, salt: Buffer, iterations: number): Buffer {
  return crypto.pbkdf2Sync(password, salt, iterations, KEY_LENGTH, DIGEST);
}

/**
 * Encrypts a private key for storage in .cmu-session using AES-256-GCM.
 * The returned authTag must be persisted and verified on decrypt so a
 * tampered session file is rejected instead of silently mis-decrypting.
 */
export function encryptSessionKey(
  password: string,
  privateKey: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
): EncryptedKey {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = deriveKey(password, salt, iterations);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encryptedKey = cipher.update(privateKey, "utf8", "hex");
  encryptedKey += cipher.final("hex");

  return {
    encryptedKey,
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    authTag: cipher.getAuthTag().toString("hex"),
    iterations,
  };
}

/**
 * Re-derives the AES key and decrypts the private key stored in a session.
 * Any crypto failure (wrong password or tampered file, caught by the GCM
 * auth tag) is surfaced as a single clear error rather than a raw crypto
 * exception.
 *
 * @param {string} password - The session password.
 * @param {SessionData} session - The parsed .cmu-session contents.
 * @returns {string} The decrypted private key.
 */
export function decryptSessionKey(
  password: string,
  session: SessionData,
): string {
  if (
    !session.encryptedKey ||
    !session.salt ||
    !session.iv ||
    !session.authTag
  ) {
    throw new Error(
      "the session file does not contain an encrypted key.\n" +
        "\x1b[2mhint:\x1b[0m run `cmu wallet login` to create one.",
    );
  }

  try {
    const iterations = session.iterations ?? LEGACY_PBKDF2_ITERATIONS;
    const key = deriveKey(
      password,
      Buffer.from(session.salt, "hex"),
      iterations,
    );
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(session.iv, "hex"),
    );
    decipher.setAuthTag(Buffer.from(session.authTag, "hex"));

    let decrypted = decipher.update(session.encryptedKey, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    throw new Error(
      "Invalid session password, or .cmu-session is from an older version or has been tampered with.\n" +
        "\x1b[2mhint:\x1b[0m run `cmu wallet login` again to recreate the session.",
    );
  }
}

/**
 * Resolves a usable private key for the current CLI run.
 *
 * Priority: process.env.PRIVATE_KEY wins (env override, fully backward
 * compatible). Otherwise, if an encrypted .cmu-session exists, prompt once
 * for its password, decrypt, and cache the result in memory for the rest of
 * the process. Returns undefined when neither source is available so callers
 * can keep their existing "not defined" error behavior.
 *
 * @param {object} [options]
 * @param {boolean} [options.prompt=true] - Set false to skip the password
 *   prompt (used for `deploy --config` / `deploy --ping` dry runs).
 * @returns {Promise<string | undefined>} The resolved private key, if any.
 */
export async function resolvePrivateKey(
  options: { prompt?: boolean } = {},
): Promise<string | undefined> {
  if (process.env.PRIVATE_KEY) {
    return process.env.PRIVATE_KEY;
  }
  if (cachedKey) {
    return cachedKey;
  }

  const session = await readSession();
  if (!session?.encryptedKey) {
    return undefined;
  }
  if (options.prompt === false) {
    return undefined;
  }

  const inquirer = (await import("inquirer")).default;
  const { password } = await inquirer.prompt([
    {
      type: "password",
      name: "password",
      message: `Session password for ${session.address}:`,
      mask: "*",
    },
  ]);

  cachedKey = decryptSessionKey(password, session);
  return cachedKey;
}
