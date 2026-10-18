import { randomBytes } from "crypto";
import { existsSync } from "fs";
import { chmod, readFile, rename, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import * as path from "path";
import { LOCAL_NETWORK_NAME, LOCAL_RPC_URL, LOCAL_SYMBOL } from "./defaults";

const NETWORKS_FILE_NAME = ".cmu-networks.json";
const JSON_SPACES = 2;
const TMP_SUFFIX_BYTES = 4;

/** Owner read/write only, like .cmu-wallets.json: RPC URLs can carry credentials. */
const NETWORKS_FILE_MODE = 0o600;

export interface NetworkEntry {
  name: string;
  rpcUrl: string;
  /** Coin symbol; absent in files from before 1.7 - read it via coinSymbol(). */
  symbol?: string;
}

/**
 * Absolute path to the networks storage file. Resolved per call: tests point
 * HOME at a temp directory.
 * @returns {string} The file path.
 */
function getNetworksFilePath(): string {
  return path.join(homedir(), NETWORKS_FILE_NAME);
}

/**
 * Replaces the networks file atomically with owner-only permissions. Kept
 * separate so every writer - the seed included - formats it the same.
 *
 * Written to a temp file next to it and renamed over it, like the wallets
 * file: a process killed mid-write leaves the old file intact. rename()
 * replaces the inode, so a file that already existed with looser permissions
 * ends up 0600 too.
 *
 * @param {string} filePath - Absolute path to .cmu-networks.json.
 * @param {NetworkEntry[]} networks - The entries to persist.
 * @returns {Promise<void>}
 */
async function writeNetworks(
  filePath: string,
  networks: NetworkEntry[],
): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(TMP_SUFFIX_BYTES).toString("hex")}.tmp`;
  try {
    await writeFile(
      tmpPath,
      `${JSON.stringify(networks, null, JSON_SPACES)}\n`,
      { mode: NETWORKS_FILE_MODE, flag: "wx" },
    );
    // The mode above is filtered through the umask; this is not.
    await chmod(tmpPath, NETWORKS_FILE_MODE);
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}

/**
 * Loads the saved networks from .cmu-networks.json.
 * Initializes with a default 'local' network if the file is missing.
 * @returns {Promise<NetworkEntry[]>} The array of saved networks.
 */
export async function loadNetworks(): Promise<NetworkEntry[]> {
  const filePath = getNetworksFilePath();

  if (!existsSync(filePath)) {
    const defaultNetworks: NetworkEntry[] = [
      { name: LOCAL_NETWORK_NAME, rpcUrl: LOCAL_RPC_URL, symbol: LOCAL_SYMBOL },
    ];
    await writeNetworks(filePath, defaultNetworks);
    return defaultNetworks;
  }
  return JSON.parse(await readFile(filePath, "utf8"));
}

/**
 * Saves a new network or updates an existing one by name.
 * @param {string} name - The network name.
 * @param {string} rpcUrl - The RPC URL.
 * @param {string} [symbol] - The coin symbol, already validated. Left out, a
 *   new entry gets no symbol key and an existing one keeps its symbol.
 * @returns {Promise<NetworkEntry>} The entry as written, kept symbol included.
 */
export async function saveNetwork(
  name: string,
  rpcUrl: string,
  symbol?: string,
): Promise<NetworkEntry> {
  const filePath = getNetworksFilePath();
  const networks = await loadNetworks();
  const existingIndex = networks.findIndex((n) => n.name === name);
  const symbolField = symbol === undefined ? {} : { symbol };

  const entry: NetworkEntry =
    existingIndex >= 0
      ? { ...networks[existingIndex], rpcUrl, ...symbolField }
      : { name, rpcUrl, ...symbolField };
  if (existingIndex >= 0) {
    networks[existingIndex] = entry;
  } else {
    networks.push(entry);
  }

  await writeNetworks(filePath, networks);
  return entry;
}

/**
 * Deletes a network by name.
 * @param {string} name - The network name to delete.
 * @returns {Promise<boolean>} True if deleted, false if not found.
 */
export async function deleteNetwork(name: string): Promise<boolean> {
  const filePath = getNetworksFilePath();
  const networks = await loadNetworks();
  const existingIndex = networks.findIndex((n) => n.name === name);

  if (existingIndex === -1) {
    return false;
  }

  networks.splice(existingIndex, 1);
  await writeNetworks(filePath, networks);
  return true;
}
