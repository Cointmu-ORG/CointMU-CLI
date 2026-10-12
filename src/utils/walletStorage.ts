import { existsSync } from "fs";
import { chmod, readFile, rename, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import * as path from "path";
import type { EncryptedKey } from "./session";

const WALLETS_FILE_NAME = ".cmu-wallets.json";
const WALLETS_FILE_VERSION = 1;
const JSON_SPACES = 2;

/** Owner read/write only, like .cmu-session: the file holds encrypted keys. */
const WALLETS_FILE_MODE = 0o600;

/**
 * A saved wallet: the encrypted key in the same shape .cmu-session stores it,
 * so decryptSessionKey() reads it and `wallet use` can copy it across as is.
 * The address is plaintext so `wallet list` needs no password.
 */
export interface WalletEntry extends EncryptedKey {
  name: string;
  address: string;
}

interface WalletsFile {
  version: number;
  wallets: WalletEntry[];
}

/**
 * Absolute path to the wallets file. Resolved per call: tests point HOME at a
 * temp directory.
 * @returns {string} The file path.
 */
export function getWalletsFilePath(): string {
  return path.join(homedir(), WALLETS_FILE_NAME);
}

/**
 * Replaces the wallets file atomically with owner-only permissions.
 *
 * Written to a temp file next to it and renamed over it, so a process killed
 * mid-write leaves the old file intact rather than a truncated one. rename()
 * replaces the inode, so the result has the temp file's 0600 even when the old
 * file was looser. Only ciphertext and addresses ever reach the temp file.
 *
 * ponytail: two concurrent writers are last-writer-wins; add a lockfile if
 * that ever bites.
 *
 * @param {WalletEntry[]} wallets - The entries to persist.
 * @returns {Promise<void>}
 */
async function writeWallets(wallets: WalletEntry[]): Promise<void> {
  const filePath = getWalletsFilePath();
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const data: WalletsFile = { version: WALLETS_FILE_VERSION, wallets };
  try {
    await writeFile(tmpPath, `${JSON.stringify(data, null, JSON_SPACES)}\n`, {
      mode: WALLETS_FILE_MODE,
      flag: "wx",
    });
    // The mode above is filtered through the umask; this is not.
    await chmod(tmpPath, WALLETS_FILE_MODE);
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}

/**
 * Loads the saved wallets. A missing file is no wallets and is not created
 * here; it appears on the first save.
 *
 * Anything unreadable throws instead of coming back empty: the next save would
 * otherwise overwrite a file full of encrypted keys with an empty list. That
 * includes a version this build does not know, which a newer cmu wrote.
 *
 * @returns {Promise<WalletEntry[]>} The saved wallets.
 * @throws {Error} When the file is malformed or from a newer version.
 */
export async function loadWallets(): Promise<WalletEntry[]> {
  const filePath = getWalletsFilePath();
  if (!existsSync(filePath)) return [];

  let data: Partial<WalletsFile> | null = null;
  try {
    data = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    // Reported below with every other unreadable shape.
  }
  if (
    typeof data?.version === "number" &&
    data.version > WALLETS_FILE_VERSION
  ) {
    throw new Error(
      `${filePath} was written by a newer version of cmu.\n` +
        "\x1b[2mhint:\x1b[0m run `cmu update`.",
    );
  }
  if (data?.version !== WALLETS_FILE_VERSION || !Array.isArray(data.wallets)) {
    throw new Error(
      `${filePath} is not a valid wallets file.\n` +
        "\x1b[2mhint:\x1b[0m restore it from a backup, or move it aside to start over.",
    );
  }
  return data.wallets;
}

/**
 * Appends a wallet. The caller has already checked the name is free.
 * @param {WalletEntry} entry - The wallet to save.
 * @returns {Promise<void>}
 */
export async function saveWallet(entry: WalletEntry): Promise<void> {
  await writeWallets([...(await loadWallets()), entry]);
}

/**
 * Deletes a wallet by name.
 * @param {string} name - The wallet to delete.
 * @returns {Promise<boolean>} True if deleted, false if not found.
 */
export async function deleteWallet(name: string): Promise<boolean> {
  const wallets = await loadWallets();
  const remaining = wallets.filter((w) => w.name !== name);
  if (remaining.length === wallets.length) return false;
  await writeWallets(remaining);
  return true;
}
