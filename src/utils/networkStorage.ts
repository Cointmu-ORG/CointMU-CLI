import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { LOCAL_NETWORK_NAME, LOCAL_RPC_URL } from "./defaults";

const NETWORKS_FILE_NAME = ".cmu-networks.json";
const JSON_SPACES = 2;

export interface NetworkEntry {
  name: string;
  rpcUrl: string;
}

/**
 * Gets the absolute path to the networks storage file lazily.
 * @returns {Promise<string>} The file path.
 */
async function getNetworksFilePath(): Promise<string> {
  const os = await import("os");
  const path = await import("path");
  return path.join(os.homedir(), NETWORKS_FILE_NAME);
}

/**
 * Writes the networks file. Kept separate so every writer formats it the same.
 * @param {string} filePath - Absolute path to .cmu-networks.json.
 * @param {NetworkEntry[]} networks - The entries to persist.
 * @returns {Promise<void>}
 */
async function writeNetworks(
  filePath: string,
  networks: NetworkEntry[],
): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(networks, null, JSON_SPACES)}\n`);
}

/**
 * Loads the saved networks from .cmu-networks.json.
 * Initializes with a default 'local' network if the file is missing.
 * @returns {Promise<NetworkEntry[]>} The array of saved networks.
 */
export async function loadNetworks(): Promise<NetworkEntry[]> {
  const filePath = await getNetworksFilePath();

  if (!existsSync(filePath)) {
    const defaultNetworks: NetworkEntry[] = [
      { name: LOCAL_NETWORK_NAME, rpcUrl: LOCAL_RPC_URL },
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
 * @returns {Promise<void>}
 */
export async function saveNetwork(name: string, rpcUrl: string): Promise<void> {
  const filePath = await getNetworksFilePath();
  const networks = await loadNetworks();
  const existingIndex = networks.findIndex((n) => n.name === name);

  if (existingIndex >= 0) {
    networks[existingIndex].rpcUrl = rpcUrl;
  } else {
    networks.push({ name, rpcUrl });
  }

  await writeNetworks(filePath, networks);
}

/**
 * Deletes a network by name.
 * @param {string} name - The network name to delete.
 * @returns {Promise<boolean>} True if deleted, false if not found.
 */
export async function deleteNetwork(name: string): Promise<boolean> {
  const filePath = await getNetworksFilePath();
  const networks = await loadNetworks();
  const existingIndex = networks.findIndex((n) => n.name === name);

  if (existingIndex === -1) {
    return false;
  }

  networks.splice(existingIndex, 1);
  await writeNetworks(filePath, networks);
  return true;
}
