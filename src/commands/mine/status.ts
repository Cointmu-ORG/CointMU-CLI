import type { Block, JsonRpcProvider } from "ethers";

export const HINT = "\x1b[2mhint:\x1b[0m";
export const WARNING = "\x1b[33mwarning:\x1b[0m";

/**
 * JSON-RPC codes for "no such method": -32601 is the spec's, -32004 is what
 * EDR (the local DevNet) answers for miner_*, eth_mining and eth_hashrate.
 */
const UNSUPPORTED_RPC_CODES = [-32601, -32004];

/**
 * Whether a provider error means the node does not have the method at all.
 * ethers maps geth's "the method ... does not exist" to UNSUPPORTED_OPERATION
 * but wraps EDR's -32004 as UNKNOWN_ERROR, so both shapes are checked.
 *
 * @param {unknown} error - The rejection from provider.send().
 * @returns {boolean} True when the method is unsupported.
 */
export function isUnsupported(error: unknown): boolean {
  const e = error as { code?: unknown; error?: { code?: unknown } } | null;
  return (
    e?.code === "UNSUPPORTED_OPERATION" ||
    UNSUPPORTED_RPC_CODES.includes(e?.error?.code as number)
  );
}

/**
 * Resolves a request to null when the node does not support it. Anything
 * else - a dropped connection above all - still rejects, so it is never shown
 * as "n/a".
 *
 * @param {Promise<T>} request - The pending RPC call.
 * @returns {Promise<T | null>} Its result, or null when unsupported.
 */
export async function optional<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    if (isUnsupported(error)) return null;
    throw error;
  }
}

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * @param {bigint | null} hashrate - eth_hashrate, or null when unsupported.
 * @returns {string} e.g. "1.20 MH/s", or "n/a".
 */
export function formatHashrate(hashrate: bigint | null): string {
  if (hashrate === null) return "n/a";
  const units = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s"];
  let value = Number(hashrate);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${unit ? value.toFixed(2) : value} ${units[unit]}`;
}

/**
 * @param {number} seconds - Age of a block.
 * @returns {string} e.g. "12s", "11m", "3h".
 */
export function formatAge(seconds: number): string {
  // A node clock slightly ahead of ours would print a negative age.
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export interface MiningStatus {
  mining: boolean | null;
  hashrate: bigint | null;
  coinbase: string | null;
  block: Block;
  balance: bigint;
}

/**
 * Everything `mine status` and each watch poll show. The balance is read at
 * the same block as the one returned, so the two always agree.
 *
 * @param {JsonRpcProvider} provider - Provider for the active network.
 * @param {string} address - The session wallet.
 * @returns {Promise<MiningStatus>} The node's mining state.
 */
export async function readStatus(
  provider: JsonRpcProvider,
  address: string,
): Promise<MiningStatus> {
  const block = await provider.getBlock("latest");
  if (!block) throw new Error("the node returned no latest block.");

  const [mining, hashrate, coinbase, balance] = await Promise.all([
    optional<boolean>(provider.send("eth_mining", [])),
    optional<string>(provider.send("eth_hashrate", [])),
    optional<string>(provider.send("eth_coinbase", [])),
    provider.getBalance(address, block.number),
  ]);

  return {
    mining,
    hashrate: hashrate === null ? null : BigInt(hashrate),
    coinbase,
    block,
    balance,
  };
}

/**
 * Sends a miner_* call, turning "no such method" into an error that says why:
 * the local DevNet has no miner API at all.
 */
export async function sendMiner(
  provider: JsonRpcProvider,
  networkName: string,
  method: string,
  params: unknown[],
): Promise<void> {
  try {
    await provider.send(method, params);
  } catch (error) {
    if (!isUnsupported(error)) throw error;
    throw new Error(
      `network '${networkName}' has no ${method} RPC, so mining cannot be controlled here.\n` +
        `${HINT} the local DevNet mines a block for each transaction by itself; \`cmu mine\` is for a geth node with the miner API enabled.`,
      { cause: error },
    );
  }
}
