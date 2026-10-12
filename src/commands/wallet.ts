import { Command } from "commander";
import { LOCAL_NETWORK_NAME } from "../utils/defaults";
import { fail } from "../utils/errors";
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
 * @returns {Promise<void>}
 */
export async function runWalletCreate(
  options: { verbose?: boolean; login?: boolean } = {},
): Promise<void> {
  const { ethers } = await import("ethers");
  const wallet = ethers.Wallet.createRandom();

  if (options.login) {
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
    "\x1b[2mhint:\x1b[0m `cmu wallet create --login` encrypts the key into a session",
  );
  console.log("instead of printing it.\n");
  console.log("To start an encrypted local session with this wallet, run:");
  console.log("  cmu wallet login");
}

/**
 * Securely log into a wallet and create an encrypted session.
 * @returns {Promise<void>}
 */
export async function runWalletLogin(): Promise<void> {
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
 * Saves a private key as a named wallet in ~/.cmu-wallets.json, encrypted
 * with its own password. The name is checked before anything is prompted.
 *
 * @param {string} name - The name to save the wallet under.
 * @returns {Promise<void>}
 */
export async function runWalletSave(name: string): Promise<void> {
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
      "\x1b[2mhint:\x1b[0m enter it again with `cmu wallet login` or `cmu wallet save` if you still need it.",
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
    "Encrypt the new key straight into a session instead of printing it",
  )
  .action((options, command) =>
    runWalletCreate(options).catch(
      fail("wallet create", command.optsWithGlobals()),
    ),
  );

walletCommand
  .command("login")
  .description("Log in and store the key in an encrypted session")
  .action((options, command) =>
    runWalletLogin().catch(fail("wallet login", command.optsWithGlobals())),
  );

walletCommand
  .command("balance")
  .description("Show the native token balance of the logged-in wallet")
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
