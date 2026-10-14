import { loadWallets, type WalletEntry } from "../../utils/walletStorage";

/** 1-32 lowercase letters, digits, '-' or '_'; never starts like a flag. */
const WALLET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Compares two addresses ignoring checksum case.
 * @param {string} [a] - An address.
 * @param {string} [b] - Another address.
 * @returns {boolean} True when both are set and equal.
 */
export function sameAddress(a?: string, b?: string): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * Looks up a saved wallet, or explains that there is none by that name.
 * @param {WalletEntry[]} wallets - The saved wallets.
 * @param {string} name - The wallet to find.
 * @returns {WalletEntry} The wallet.
 * @throws {Error} When no wallet has that name.
 */
export function findWallet(wallets: WalletEntry[], name: string): WalletEntry {
  const wallet = wallets.find((w) => w.name === name);
  if (!wallet) {
    throw new Error(
      `wallet '${name}' is not saved.\n` +
        "\x1b[2mhint:\x1b[0m list saved wallets with `cmu wallet list`.",
    );
  }
  return wallet;
}

/**
 * Checks that a new wallet can be saved under this name, before anything is
 * prompted or generated.
 *
 * @param {string} name - The name to save the wallet under.
 * @returns {Promise<WalletEntry[]>} The wallets already saved.
 * @throws {Error} When the name is invalid or taken, or the store unreadable.
 */
export async function checkNewWalletName(name: string): Promise<WalletEntry[]> {
  if (!WALLET_NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid wallet name '${name}'.\n` +
        "\x1b[2mhint:\x1b[0m use 1-32 lowercase letters, digits, '-' or '_', starting with a letter or digit.",
    );
  }
  const wallets = await loadWallets();
  if (wallets.some((w) => w.name === name)) {
    throw new Error(
      `wallet '${name}' is already saved.\n` +
        `\x1b[2mhint:\x1b[0m run \`cmu wallet delete ${name}\` first to replace it.`,
    );
  }
  return wallets;
}
