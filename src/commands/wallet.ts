import { Command } from "commander";
import { LOCAL_NETWORK_NAME } from "../utils/defaults";
import { fail } from "../utils/errors";
import { pingNetwork } from "./deploy";
import { getDynamicNetwork } from "../utils/network";
import { loadNetworks } from "../utils/networkStorage";
import {
  deleteWallet,
  loadWallets,
  saveWallet,
  type WalletEntry,
} from "../utils/walletStorage";
import {
  decryptSessionKey,
  type EncryptedKey,
  encryptSessionKey,
  getSessionFilePath,
  readSession,
  requireSession,
  validatePasswordStrength,
  writeSessionFile,
} from "../utils/session";

/**
 * The activeNetwork a new session should carry: the one the existing session
 * selected, as long as it is still saved. Falls back to the local devnet for a
 * first login, an unreadable session file, or a pick that has since been
 * deleted - and says so in that last case, since the user did choose it.
 *
 * @returns {Promise<string>} The network name the new session should record.
 */
async function carriedOverNetwork(): Promise<string> {
  let previous: string | undefined;
  try {
    previous = (await readSession())?.activeNetwork;
  } catch {
    // A corrupt session file must not block login - login is the way out of it.
    return LOCAL_NETWORK_NAME;
  }
  if (!previous) return LOCAL_NETWORK_NAME;

  if ((await loadNetworks()).some((n) => n.name === previous)) return previous;

  console.log(
    `\x1b[33mwarning:\x1b[0m network '${previous}' is no longer saved - ` +
      `active network reset to ${LOCAL_NETWORK_NAME}.`,
  );
  return LOCAL_NETWORK_NAME;
}

/**
 * Refuses to prompt when stdin is not a terminal. inquirer cannot read a
 * masked answer from a pipe: a closed stdin fails with an unhelpful "force
 * closed the prompt", and a pipe that stays open hangs forever.
 *
 * @param {string} what - What the prompt would have asked for.
 * @param {string} [hint] - What to do instead.
 * @throws {Error} When stdin is not a TTY.
 */
function requireInteractive(
  what: string,
  hint = "run this in a terminal; in CI, set PRIVATE_KEY instead.",
): void {
  if (!process.stdin.isTTY) {
    throw new Error(
      `cannot prompt for ${what} in a non-interactive session.\n` +
        `\x1b[2mhint:\x1b[0m ${hint}`,
    );
  }
}

/**
 * Prompts for a private key, masked, and rejects anything that is not one.
 * The validation message never echoes the input.
 *
 * @returns {Promise<string>} The entered private key.
 */
async function promptPrivateKey(): Promise<string> {
  requireInteractive("a private key");
  const inquirer = (await import("inquirer")).default;
  const { ethers } = await import("ethers");

  const { privateKey } = await inquirer.prompt([
    {
      type: "password",
      name: "privateKey",
      message: "Private key:",
      mask: "*",
      validate: (input: string) => {
        try {
          new ethers.Wallet(input);
          return true;
        } catch {
          return "invalid private key - expected a 32-byte hex key (0x-prefixed).";
        }
      },
    },
  ]);
  return privateKey;
}

/**
 * Prompts for a new password that passes validatePasswordStrength().
 *
 * @param {string} [message] - The prompt text.
 * @param {boolean} [confirm] - Ask twice and require both to match. For a
 *   saved wallet, where a typo would lock the entry for good: decrypting with
 *   the same mistyped password round-trips fine and cannot catch it.
 * @returns {Promise<string>} The entered password.
 * @throws {Error} When confirm is set and the two entries differ.
 */
async function promptNewPassword(
  message = "New session password:",
  confirm = false,
): Promise<string> {
  requireInteractive("a password");
  const inquirer = (await import("inquirer")).default;

  const { password } = await inquirer.prompt([
    {
      type: "password",
      name: "password",
      message,
      mask: "*",
      validate: validatePasswordStrength,
    },
  ]);
  if (!confirm) return password;

  const { confirmPassword } = await inquirer.prompt([
    {
      type: "password",
      name: "confirmPassword",
      message: "Confirm password:",
      mask: "*",
    },
  ]);
  if (password !== confirmPassword) {
    throw new Error(
      "passwords do not match.\n" +
        "\x1b[2mhint:\x1b[0m nothing was saved; run the command again.",
    );
  }
  return password;
}

/**
 * Writes an encrypted key to .cmu-session, carrying the active network over.
 *
 * The one writer of a key into the session, so every way of getting there
 * (`login`, `create --login`, `use`) keeps the network #126 was about.
 *
 * @param {string} address - The address the key belongs to.
 * @param {EncryptedKey} encrypted - The encrypted key.
 * @returns {Promise<string>} The network the session ended up pointing at.
 */
async function storeSession(
  address: string,
  encrypted: EncryptedKey,
): Promise<string> {
  const activeNetwork = await carriedOverNetwork();
  await writeSessionFile(getSessionFilePath(), {
    address,
    activeNetwork,
    ...encrypted,
  });
  return activeNetwork;
}

/**
 * Prompts for a session password, encrypts the given private key with it and
 * writes the result to .cmu-session.
 *
 * Shared by `wallet login` and `wallet create --login` so both go through one
 * implementation of the encrypt-and-store path. The key is never printed.
 *
 * @param {string} privateKey - The private key to encrypt.
 * @returns {Promise<{address: string, activeNetwork: string}>} The address the
 *   session belongs to, and the network it ended up pointing at.
 */
async function createEncryptedSession(
  privateKey: string,
): Promise<{ address: string; activeNetwork: string }> {
  const password = await promptNewPassword();
  const { ethers } = await import("ethers");

  const { address } = new ethers.Wallet(privateKey);
  const activeNetwork = await storeSession(
    address,
    encryptSessionKey(password, privateKey),
  );
  return { address, activeNetwork };
}

/**
 * Generates a new, secure EVM-compatible wallet.
 * @param {object} [options]
 * @param {boolean} [options.login] - Encrypt it into .cmu-session (deprecated).
 * @param {string} [options.save] - Encrypt it into the store under this name.
 * @returns {Promise<void>}
 */
export async function runWalletCreate(
  options: { verbose?: boolean; login?: boolean; save?: string } = {},
): Promise<void> {
  if (options.save !== undefined) {
    if (options.login) {
      throw new Error(
        "--save and --login cannot be combined.\n" +
          "\x1b[2mhint:\x1b[0m use --save <name>; --login is deprecated.",
      );
    }
    return runWalletCreateSaved(options.save);
  }

  const { ethers } = await import("ethers");
  const wallet = ethers.Wallet.createRandom();

  if (options.login) {
    // Deprecated by #194. stderr, so the stdout below stays as it was.
    console.warn(
      "\n\x1b[33mwarning:\x1b[0m `cmu wallet create --login` is deprecated and will be removed in a later 1.x release.",
    );
    console.warn(
      "\x1b[2mhint:\x1b[0m run `cmu wallet create --save <name>`, then `cmu wallet use <name>` - the key is stored encrypted and a mnemonic backup is printed.\n",
    );
    // The generated key goes straight into the encrypted session. Neither it
    // nor the mnemonic is passed to console.log anywhere on this path, so
    // nothing recoverable reaches scrollback or a CI log.
    const { address, activeNetwork } = await createEncryptedSession(
      wallet.privateKey,
    );
    console.log("New CointMU wallet");
    console.log("===========================");
    console.log(`Address : ${address}`);
    console.log("===========================");
    console.log("Session encrypted and saved.");
    console.log(`Active network: ${activeNetwork}`);
    console.log(
      "\n\x1b[33mwarning:\x1b[0m the private key and mnemonic were not printed - this wallet",
    );
    console.log(
      "exists only inside .cmu-session. Lose that file or its password and the funds",
    );
    console.log("in it cannot be recovered.");
    console.log(
      "\x1b[2mhint:\x1b[0m run `cmu wallet create` without --login for a printed backup.\n",
    );
    console.log(
      "`cmu deploy` will use this key automatically when PRIVATE_KEY is not set.",
    );
    return;
  }

  console.log("New CointMU wallet");
  console.log("===========================");
  console.log(`Address     : ${wallet.address}`);
  console.log(`Private key : ${wallet.privateKey}`);
  if (wallet.mnemonic) {
    console.log(`Mnemonic    : ${wallet.mnemonic.phrase}`);
  }
  console.log("===========================");
  console.log(
    "\n\x1b[33mwarning:\x1b[0m back up the private key and mnemonic now - they are shown once.",
  );
  console.log(
    "Store them offline. Without them the funds in this wallet cannot be recovered.\n",
  );
  console.log(
    "\x1b[33mwarning:\x1b[0m the values above are sensitive and stay behind in terminal",
  );
  console.log(
    "scrollback, tmux or screen logs and CI output. Clear them if this ran anywhere",
  );
  console.log("shared.");
  console.log(
    "\x1b[2mhint:\x1b[0m `cmu wallet create --save <name>` stores the key encrypted and prints only",
  );
  console.log(
    "the address and a mnemonic backup; activate it with `cmu wallet use <name>`.\n",
  );
  console.log("To keep this wallet encrypted and use it in a project, run:");
  console.log("  cmu wallet save <name>");
  console.log("  cmu wallet use <name>");
}

/**
 * Securely log into a wallet and create an encrypted session.
 * @returns {Promise<void>}
 */
export async function runWalletLogin(): Promise<void> {
  // Deprecated by #194. stderr, so the stdout below stays as it was.
  console.warn(
    "\n\x1b[33mwarning:\x1b[0m `cmu wallet login` is deprecated and will be removed in a later 1.x release.",
  );
  console.warn(
    "\x1b[2mhint:\x1b[0m save the key once with `cmu wallet save <name>`, then run `cmu wallet use <name>` in the project.\n",
  );
  const privateKey = await promptPrivateKey();
  const { address, activeNetwork } = await createEncryptedSession(privateKey);
  console.log("Session encrypted and saved.");
  console.log(`Logged in as ${address}`);
  console.log(`Active network: ${activeNetwork}`);
  console.log(
    "`cmu deploy` will use this key automatically when PRIVATE_KEY is not set.",
  );
}

/** 1-32 lowercase letters, digits, '-' or '_'; never starts like a flag. */
const WALLET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Compares two addresses ignoring checksum case.
 * @param {string} [a] - An address.
 * @param {string} [b] - Another address.
 * @returns {boolean} True when both are set and equal.
 */
function sameAddress(a?: string, b?: string): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * The address this project's .cmu-session belongs to. Needs no password: the
 * address is stored in plaintext. An unreadable session counts as none, so it
 * cannot stop `list` or `use` - `use` is a way out of it.
 *
 * @returns {Promise<string | undefined>} The address, if there is a session.
 */
async function sessionAddress(): Promise<string | undefined> {
  try {
    return (await readSession())?.address;
  } catch {
    return undefined;
  }
}

/**
 * Looks up a saved wallet, or explains that there is none by that name.
 * @param {WalletEntry[]} wallets - The saved wallets.
 * @param {string} name - The wallet to find.
 * @returns {WalletEntry} The wallet.
 * @throws {Error} When no wallet has that name.
 */
function findWallet(wallets: WalletEntry[], name: string): WalletEntry {
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
async function checkNewWalletName(name: string): Promise<WalletEntry[]> {
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

/**
 * `wallet create --save <name>`: generates a wallet straight into the store.
 *
 * Nothing is generated until the name is free and the password confirmed, and
 * nothing is printed until the encrypted entry is on disk, so a failure at any
 * step leaves no mnemonic behind for a wallet that was never saved. The
 * private key is never printed. The store keeps only that key, encrypted, so
 * the printed mnemonic is the one backup.
 *
 * @param {string} name - The name to save the wallet under.
 * @returns {Promise<void>}
 */
async function runWalletCreateSaved(name: string): Promise<void> {
  await checkNewWalletName(name);
  const password = await promptNewPassword("Wallet password:", true);

  const { ethers } = await import("ethers");
  const wallet = ethers.Wallet.createRandom();
  await saveWallet({
    name,
    address: wallet.address,
    ...encryptSessionKey(password, wallet.privateKey),
  });

  console.log("New CointMU wallet");
  console.log("===========================");
  console.log(`Address  : ${wallet.address}`);
  if (wallet.mnemonic) {
    console.log(`Mnemonic : ${wallet.mnemonic.phrase}`);
  }
  console.log("===========================");
  console.log(
    `Saved wallet '${name}' (${wallet.address}), encrypted in ~/.cmu-wallets.json.`,
  );
  console.log(
    "\n\x1b[33mwarning:\x1b[0m write the mnemonic down now - it is shown once and cmu keeps no copy.",
  );
  console.log(
    "~/.cmu-wallets.json holds only the private key, encrypted with your password.",
  );
  console.log(
    "If you lose that file or forget the password, the mnemonic is the only way to",
  );
  console.log(
    "recover this wallet - and anyone who reads it controls the funds.\n",
  );
  console.log(
    "\x1b[33mwarning:\x1b[0m the mnemonic stays behind in terminal scrollback, tmux or screen logs",
  );
  console.log("and CI output. Clear them if this ran anywhere shared.");
  console.log(
    `\x1b[2mhint:\x1b[0m run \`cmu wallet use ${name}\` in a project to make it active there.`,
  );
}

/**
 * Saves a private key as a named wallet in ~/.cmu-wallets.json, encrypted
 * with its own password. The name is checked before anything is prompted.
 *
 * @param {string} name - The name to save the wallet under.
 * @returns {Promise<void>}
 */
export async function runWalletSave(name: string): Promise<void> {
  const wallets = await checkNewWalletName(name);

  const privateKey = await promptPrivateKey();
  const { ethers } = await import("ethers");
  const { address } = new ethers.Wallet(privateKey);

  const twin = wallets.find((w) => sameAddress(w.address, address));
  if (twin) {
    console.log(
      `\x1b[33mwarning:\x1b[0m this key is already saved as '${twin.name}'.`,
    );
  }

  const password = await promptNewPassword("Wallet password:", true);
  await saveWallet({
    name,
    address,
    ...encryptSessionKey(password, privateKey),
  });

  console.log(`Saved wallet '${name}' (${address})`);
  console.log(
    `\x1b[2mhint:\x1b[0m run \`cmu wallet use ${name}\` in a project to make it active there.`,
  );
}

/**
 * Makes a saved wallet the active session of the current project.
 *
 * The wallet's password is checked by decrypting, and the address is taken
 * from the decrypted key: the stored one is plaintext and not covered by the
 * GCM tag. The ciphertext is then copied into .cmu-session as is - same
 * plaintext, key and IV, so the copy is byte-identical - and the session opens
 * with the wallet's password. It is a copy: deleting the wallet later does not
 * touch this session.
 *
 * @param {string} name - The wallet to activate.
 * @returns {Promise<void>}
 */
export async function runWalletUse(name: string): Promise<void> {
  const wallets = await loadWallets();
  const wallet = findWallet(wallets, name);

  requireInteractive("a password");
  const inquirer = (await import("inquirer")).default;
  const { password } = await inquirer.prompt([
    {
      type: "password",
      name: "password",
      message: `Password for wallet '${name}':`,
      mask: "*",
    },
  ]);

  let privateKey: string;
  try {
    privateKey = decryptSessionKey(password, wallet);
  } catch {
    throw new Error(
      `wrong password for wallet '${name}', or ~/.cmu-wallets.json has been tampered with.`,
    );
  }
  const { ethers } = await import("ethers");
  const { address } = new ethers.Wallet(privateKey);
  if (!sameAddress(address, wallet.address)) {
    throw new Error(
      `wallet '${name}' does not hold the key for ${wallet.address} - ~/.cmu-wallets.json has been modified.\n` +
        `\x1b[2mhint:\x1b[0m run \`cmu wallet delete ${name}\` and save the key again.`,
    );
  }

  // The one way `use` can lose a key for good: a session made by `login`
  // whose key was never saved.
  const previous = await sessionAddress();
  if (
    previous &&
    !sameAddress(previous, address) &&
    !wallets.some((w) => sameAddress(w.address, previous))
  ) {
    console.log(
      `\x1b[33mwarning:\x1b[0m replacing the session for ${previous} - that key is not a saved wallet.`,
    );
    console.log(
      "\x1b[2mhint:\x1b[0m enter it again with `cmu wallet save <name>` if you still need it.",
    );
  }

  const { encryptedKey, salt, iv, authTag, iterations } = wallet;
  const activeNetwork = await storeSession(address, {
    encryptedKey,
    salt,
    iv,
    authTag,
    iterations,
  });
  console.log(`Active wallet is now '${name}' (${address})`);
  console.log(`Active network: ${activeNetwork}`);
}

/**
 * Lists the saved wallets, marking the ones this project's session holds.
 * @returns {Promise<void>}
 */
export async function runWalletList(): Promise<void> {
  const wallets = await loadWallets();
  if (wallets.length === 0) {
    console.log("No saved wallets.");
    console.log("\x1b[2mhint:\x1b[0m save one with `cmu wallet save <name>`.");
    return;
  }
  const active = await sessionAddress();

  console.log("\nSaved wallets");
  console.log(
    "==========================================================================",
  );
  console.log("| Active | Name                             | Address");
  console.log(
    "--------------------------------------------------------------------------",
  );
  for (const w of wallets) {
    const isActive = sameAddress(w.address, active) ? "[*]   " : "      ";
    console.log(`| ${isActive} | ${w.name.padEnd(32)} | ${w.address}`);
  }
  console.log(
    "==========================================================================\n",
  );
}

/**
 * Deletes a saved wallet after confirmation. Sessions that already `use` it
 * hold their own encrypted copy, so they keep working.
 *
 * @param {string} name - The wallet to delete.
 * @param {object} [options]
 * @param {boolean} [options.yes] - Skip the confirmation (`--yes`).
 * @returns {Promise<void>}
 */
export async function runWalletDelete(
  name: string,
  options: { yes?: boolean } = {},
): Promise<void> {
  const wallet = findWallet(await loadWallets(), name);

  if (!options.yes) {
    requireInteractive(
      "confirmation",
      "re-run with --yes to delete without asking.",
    );
    const inquirer = (await import("inquirer")).default;
    const { proceed } = await inquirer.prompt([
      {
        type: "confirm",
        name: "proceed",
        message: `Delete wallet '${name}' (${wallet.address})? cmu keeps no other copy of its key.`,
        default: false,
      },
    ]);
    if (!proceed) {
      console.log("Nothing deleted.");
      return;
    }
  }

  await deleteWallet(name);
  console.log(`Deleted wallet '${name}'.`);
  if (sameAddress(await sessionAddress(), wallet.address)) {
    console.log(
      "This project's .cmu-session keeps its own copy and still works.",
    );
  }
  console.log(
    `\x1b[2mhint:\x1b[0m projects that already ran \`cmu wallet use ${name}\` keep their own encrypted copy in .cmu-session.`,
  );
}

/** Exactly 0x and 40 hex digits: no ENS name, ICAP, missing prefix or padding. */
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** A plain decimal ETH amount, at most 18 decimals (1 wei). */
const AMOUNT_PATTERN = /^[0-9]+(\.[0-9]{1,18})?$/;

/**
 * Turns the transfer recipient into a checksummed hex address.
 *
 * Stricter than ethers.isAddress(), which also takes a bare 40-digit hex
 * string and an ICAP "XE..." one. Only the getAddress() result is ever handed
 * to the provider, so nothing that looks like a name can reach ENS resolution.
 *
 * @param {string} to - The recipient as typed.
 * @returns {Promise<string>} The checksummed address.
 * @throws {Error} When it is not a 0x-prefixed address, or its mixed-case
 *   checksum is wrong.
 */
export async function parseTransferAddress(to: string): Promise<string> {
  if (!ADDRESS_PATTERN.test(to)) {
    throw new Error(
      `invalid recipient ${JSON.stringify(to)} - expected a 0x-prefixed 40-digit hex address.\n` +
        "\x1b[2mhint:\x1b[0m ENS names are not resolved; paste the address itself.",
    );
  }
  const { ethers } = await import("ethers");
  try {
    return ethers.getAddress(to);
  } catch {
    throw new Error(
      `bad address checksum for '${to}'.\n` +
        "\x1b[2mhint:\x1b[0m a mixed-case address encodes a checksum - check for a typo, or paste it all lowercase.",
    );
  }
}

/**
 * Turns the transfer amount, in ETH, into wei.
 *
 * Stricter than parseEther(), which on its own takes "-1", "0", "1." and
 * ".5". Only plain positive decimals pass.
 *
 * @param {string} amount - The amount as typed, in ETH.
 * @returns {Promise<bigint>} The amount in wei.
 * @throws {Error} When it is not a positive decimal with at most 18 decimals.
 */
export async function parseTransferAmount(amount: string): Promise<bigint> {
  if (/^[0-9]+\.[0-9]{19,}$/.test(amount)) {
    throw new Error(
      `amount '${amount}' has more than 18 decimals - 1 wei is 0.000000000000000001 ETH.`,
    );
  }
  if (!AMOUNT_PATTERN.test(amount)) {
    throw new Error(
      `invalid amount ${JSON.stringify(amount)} - expected a positive decimal ETH value like 0.5.\n` +
        "\x1b[2mhint:\x1b[0m no sign, exponent, separators or bare leading/trailing dot: write 1 or 0.5.",
    );
  }
  const { ethers } = await import("ethers");
  const wei = ethers.parseEther(amount);
  if (wei === 0n) {
    throw new Error("amount must be greater than 0.");
  }
  return wei;
}

/**
 * How long `wallet transfer` waits for its transaction to land in a block.
 *
 * ponytail: picked for the local devnet, which mines on demand. Not yet
 * validated against the server node's block time - mining there has never
 * been tested. Raise it if confirmations routinely take longer.
 */
export const TRANSFER_CONFIRM_TIMEOUT_MS = 120_000;

/** Exit code: the transfer was sent and is in a block. */
export const TRANSFER_SENT = 0;

/**
 * Exit code: the transfer WAS sent but is not confirmed yet. Distinct from 1
 * ("nothing was sent") so a script does not retry it into a double send.
 */
export const TRANSFER_UNCONFIRMED = 2;

/**
 * Runs a prompt, turning Ctrl-C (inquirer's ExitPromptError) into the same
 * "aborted" a No answer gives, so either way it is plain that nothing left.
 *
 * @param {() => Promise<T>} prompt - The prompt to run.
 * @returns {Promise<T>} Its answers.
 */
async function promptOrAbort<T>(prompt: () => Promise<T>): Promise<T> {
  try {
    return await prompt();
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      throw new Error("aborted: nothing was sent.", { cause: error });
    }
    throw error;
  }
}

/**
 * The short message of an ethers error, without the request payloads its full
 * message carries.
 *
 * @param {unknown} error - The caught value.
 * @returns {string} Something printable.
 */
function shortError(error: unknown): string {
  const short = (error as { shortMessage?: string })?.shortMessage;
  return short ?? (error instanceof Error ? error.message : String(error));
}

/**
 * Sends ETH from the session wallet on the session's active network.
 *
 * Everything that can be checked is checked before the first prompt: the
 * recipient and amount, the session, the node, the balance against
 * amount + max fee, and the zero address under --yes. Only then is the
 * session password asked for, the summary shown and - unless --yes - a No-by-
 * default confirmation asked. --yes skips that one question and nothing else.
 *
 * The key always comes from .cmu-session, never from PRIVATE_KEY: the network
 * and balance shown are the session's, and index.ts loads the project's .env
 * on every run, so an env key would sign from an account the user never saw.
 *
 * Never exits by itself; the handler exits with the code this resolves to.
 *
 * @param {string} toArg - The recipient, as typed.
 * @param {string} amountArg - The amount in ETH, as typed.
 * @param {object} [options]
 * @param {boolean} [options.yes] - Skip the confirmation (`--yes`).
 * @returns {Promise<0 | 2>} TRANSFER_SENT, or TRANSFER_UNCONFIRMED when the
 *   transaction went out but did not land in a block in time.
 * @throws {Error} For anything that stopped it before or at sending, and for a
 *   transaction that was mined but reverted.
 */
export async function runWalletTransfer(
  toArg: string,
  amountArg: string,
  options: { yes?: boolean } = {},
): Promise<0 | 2> {
  const to = await parseTransferAddress(toArg);
  const value = await parseTransferAmount(amountArg);

  const session = await requireSession();
  if (!session.encryptedKey) {
    throw new Error(
      "the session holds no encrypted key.\n" +
        "\x1b[2mhint:\x1b[0m run `cmu wallet use <name>`.",
    );
  }
  const from = session.address;

  const network = await getDynamicNetwork(session.activeNetwork);
  // Fails within its timeout when the node is down; a bare provider would
  // retry network detection forever.
  await pingNetwork(network.rpcUrl, network.name);
  const { ethers } = await import("ethers");
  const provider = new ethers.JsonRpcProvider(network.rpcUrl, undefined, {
    staticNetwork: true,
  });
  const { chainId } = await provider.getNetwork();

  const [balance, feeData, code] = await Promise.all([
    provider.getBalance(from),
    provider.getFeeData(),
    provider.getCode(to),
  ]);
  // Before estimateGas: a node refuses to estimate a transfer the balance
  // cannot cover, which would read as "the recipient rejects it".
  if (balance < value) {
    throw new Error(
      `insufficient balance: ${ethers.formatEther(balance)} ETH, the transfer needs ${ethers.formatEther(value)} ETH plus fee.`,
    );
  }
  let gasLimit: bigint;
  try {
    gasLimit = await provider.estimateGas({ from, to, value });
  } catch (error) {
    throw new Error(
      `${to} would reject this transfer - the node could not estimate it (${shortError(error)}).\n` +
        "\x1b[2mhint:\x1b[0m a contract without a payable receive() or fallback() cannot take plain ETH.",
      { cause: error },
    );
  }

  // Fee fields are sent explicitly, so maxFee is a real ceiling rather than a
  // guess ethers might re-price while populating the transaction.
  const price = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (price == null) {
    throw new Error("the node returned no fee data - cannot bound the fee.");
  }
  const feeFields =
    feeData.maxFeePerGas != null
      ? {
          type: 2,
          maxFeePerGas: feeData.maxFeePerGas,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
        }
      : { type: 0, gasPrice: price };
  const maxFee = gasLimit * price;
  if (balance < value + maxFee) {
    throw new Error(
      `balance ${ethers.formatEther(balance)} ETH covers the amount but not the max fee (${ethers.formatEther(maxFee)} ETH).`,
    );
  }

  const toZero = to === ethers.ZeroAddress;
  if (toZero && options.yes) {
    throw new Error(
      "--yes does not cover sending to the zero address.\n" +
        "\x1b[2mhint:\x1b[0m run without --yes to confirm interactively.",
    );
  }

  const warn = (text: string) => console.log(`\x1b[33mwarning:\x1b[0m ${text}`);
  if (process.env.PRIVATE_KEY) {
    warn(
      "PRIVATE_KEY is set (environment or .env) - transfer ignores it and signs with the session wallet.",
    );
  }
  if (toZero) {
    warn("funds sent to the zero address are burned and cannot be recovered.");
  }
  if (sameAddress(to, from)) {
    warn(`${to} is the sending wallet - this only spends the fee.`);
  }
  if (code !== "0x") {
    warn(`${to} is a contract - plain ETH can be rejected or locked by it.`);
  }

  requireInteractive(
    "the session password",
    "transfer signs with the .cmu-session key and needs its password; run it in a terminal.",
  );
  const inquirer = (await import("inquirer")).default;
  const { password } = await promptOrAbort(() =>
    inquirer.prompt([
      {
        type: "password",
        name: "password",
        message: `Session password for ${from}:`,
        mask: "*",
      },
    ]),
  );
  const signer = new ethers.Wallet(
    decryptSessionKey(password, session),
    provider,
  );
  // The balance above was checked for the plaintext session address; make
  // sure that is really who signs.
  if (!sameAddress(signer.address, from)) {
    throw new Error(
      `.cmu-session names ${from}, but its key belongs to another address - the file has been modified.\n` +
        "\x1b[2mhint:\x1b[0m run `cmu wallet use <name>` again.",
    );
  }

  let savedAs: string | undefined;
  try {
    savedAs = (await loadWallets()).find((w) =>
      sameAddress(w.address, from),
    )?.name;
  } catch {
    // An unreadable wallets file only costs the summary its wallet name.
  }

  console.log("\n--- Transfer ---");
  console.log(`Network : ${network.name} (chain ID ${chainId})`);
  console.log(
    `From    : ${signer.address} (.cmu-session${savedAs ? `, saved as '${savedAs}'` : ""})`,
  );
  console.log(`To      : ${to}`);
  console.log(`Amount  : ${ethers.formatEther(value)} ETH (${value} wei)`);
  console.log(`Max fee : ${ethers.formatEther(maxFee)} ETH`);
  console.log("----------------");

  if (!options.yes) {
    const { proceed } = await promptOrAbort(() =>
      inquirer.prompt([
        {
          type: "confirm",
          name: "proceed",
          message: "Send this transaction?",
          default: false,
        },
      ]),
    );
    if (!proceed) {
      throw new Error("aborted: nothing was sent.");
    }
  }

  let tx;
  try {
    tx = await signer.sendTransaction({ to, value, gasLimit, ...feeFields });
  } catch (error) {
    throw new Error(
      `could not send the transaction: ${shortError(error)}\n` +
        "\x1b[2mhint:\x1b[0m if this was a network error the transaction may still have been broadcast - check `cmu wallet balance` before retrying.",
      { cause: error },
    );
  }
  // Printed before waiting, so a Ctrl-C during the wait still leaves the hash.
  console.log(`Tx hash : ${tx.hash}`);
  console.log(
    `Waiting for 1 confirmation (up to ${TRANSFER_CONFIRM_TIMEOUT_MS / 1000}s)...`,
  );

  let receipt;
  try {
    receipt = await tx.wait(1, TRANSFER_CONFIRM_TIMEOUT_MS);
  } catch (error) {
    if (ethers.isError(error, "CALL_EXCEPTION")) {
      throw new Error(
        `transaction ${tx.hash} was mined but reverted - the fee was paid, the amount was not transferred.`,
        { cause: error },
      );
    }
    // Sent either way, so never the "nothing was sent" exit code.
    warn(
      ethers.isError(error, "TIMEOUT")
        ? `transaction ${tx.hash} was sent but is not in a block after ${TRANSFER_CONFIRM_TIMEOUT_MS / 1000}s.`
        : `transaction ${tx.hash} was sent, but its confirmation could not be checked (${shortError(error)}).`,
    );
    console.log(
      "\x1b[2mhint:\x1b[0m blocks only appear while something mines - `cmu mine start`, then check `cmu wallet balance` before sending again.",
    );
    return TRANSFER_UNCONFIRMED;
  }

  const newBalance = await provider.getBalance(from);
  console.log("---------------------------");
  console.log(`Block   : ${receipt?.blockNumber}`);
  console.log(`Balance : ${ethers.formatEther(newBalance)} ETH`);
  console.log("---------------------------");
  return TRANSFER_SENT;
}

/**
 * Fetch and display the native token balance of the logged-in wallet.
 * @returns {Promise<void>}
 */
async function runWalletBalance(): Promise<void> {
  const session = await requireSession();

  const { ethers } = await import("ethers");

  const network = await getDynamicNetwork(session.activeNetwork);
  const provider = new ethers.JsonRpcProvider(network.rpcUrl);

  console.log(`Connecting to ${network.name} (${network.rpcUrl})...`);
  const balance = await provider.getBalance(session.address);

  console.log("---------------------------");
  console.log(`Address : ${session.address}`);
  console.log(`Balance : ${ethers.formatEther(balance)} ETH`);
  console.log("---------------------------");
}

/**
 * Display the current active wallet session information.
 * @returns {Promise<void>}
 */
async function runWalletInfo(): Promise<void> {
  const session = await requireSession();

  const network = await getDynamicNetwork(session.activeNetwork);

  console.log("--- Active session ---");
  console.log(`Address      : ${session.address}`);
  console.log(`Network      : ${network.name}`);
  console.log(`RPC endpoint : ${network.rpcUrl}`);
  console.log("----------------------");
}

export const walletCommand = new Command("wallet").description(
  "Manage wallets and encrypted sessions",
);

walletCommand
  .command("create")
  .description("Generate a new EVM-compatible wallet")
  .option(
    "--login",
    "Deprecated: use --save <name> (encrypts the new key into a session)",
  )
  .option(
    "--save <name>",
    "Encrypt the new key into ~/.cmu-wallets.json under <name> and print only the address and mnemonic",
  )
  .action((options, command) =>
    runWalletCreate(options).catch(
      fail("wallet create", command.optsWithGlobals()),
    ),
  );

walletCommand
  .command("login")
  .description(
    "Deprecated: use `cmu wallet save` + `cmu wallet use` (stores a key in an encrypted session)",
  )
  .action((options, command) =>
    runWalletLogin().catch(fail("wallet login", command.optsWithGlobals())),
  );

walletCommand
  .command("balance")
  .description("Show the native token balance of the active wallet")
  .action((options, command) =>
    runWalletBalance().catch(fail("wallet balance", command.optsWithGlobals())),
  );

walletCommand
  .command("info")
  .description("Show the active wallet session")
  .action((options, command) =>
    runWalletInfo().catch(fail("wallet info", command.optsWithGlobals())),
  );

walletCommand
  .command("save <name>")
  .alias("add")
  .description("Save a private key as a named, encrypted wallet")
  .action((name, options, command) =>
    runWalletSave(name).catch(fail("wallet save", command.optsWithGlobals())),
  );

walletCommand
  .command("use <name>")
  .description("Make a saved wallet the active session in this project")
  .action((name, options, command) =>
    runWalletUse(name).catch(fail("wallet use", command.optsWithGlobals())),
  );

walletCommand
  .command("list")
  .description("List saved wallets")
  .action((options, command) =>
    runWalletList().catch(fail("wallet list", command.optsWithGlobals())),
  );

walletCommand
  .command("delete <name>")
  .description("Delete a saved wallet")
  .option("-y, --yes", "Delete without asking for confirmation")
  .action((name, options, command) =>
    runWalletDelete(name, options).catch(
      fail("wallet delete", command.optsWithGlobals()),
    ),
  );

walletCommand
  .command("transfer <to> <amount>")
  .alias("tf")
  .description("Send ETH from the session wallet")
  .option("-y, --yes", "Send without asking for confirmation")
  // The exit code comes from the return value: exit 2 (sent, unconfirmed)
  // must not be flattened into the 0 other provider-holding commands force.
  .action((to, amount, options, command) =>
    runWalletTransfer(to, amount, options).then(
      (code) => process.exit(code),
      fail("wallet transfer", command.optsWithGlobals()),
    ),
  );
