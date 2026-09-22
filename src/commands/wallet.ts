import { Command } from "commander";
import { LOCAL_NETWORK_NAME } from "../utils/defaults";
import { fail } from "../utils/errors";
import { getSessionFilePath, readSession } from "../utils/session";

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

  const { loadNetworks } = await import("../utils/networkStorage");
  if ((await loadNetworks()).some((n) => n.name === previous)) return previous;

  console.log(
    `\x1b[33mwarning:\x1b[0m network '${previous}' is no longer saved - ` +
      `active network reset to ${LOCAL_NETWORK_NAME}.`,
  );
  return LOCAL_NETWORK_NAME;
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
  const inquirer = (await import("inquirer")).default;
  const { ethers } = await import("ethers");
  const { encryptSessionKey, validatePasswordStrength, writeSessionFile } =
    await import("../utils/session");

  const { password } = await inquirer.prompt([
    {
      type: "password",
      name: "password",
      message: "New session password:",
      mask: "*",
      validate: validatePasswordStrength,
    },
  ]);

  const wallet = new ethers.Wallet(privateKey);
  const activeNetwork = await carriedOverNetwork();

  await writeSessionFile(getSessionFilePath(), {
    address: wallet.address,
    activeNetwork,
    ...encryptSessionKey(password, privateKey),
  });

  return { address: wallet.address, activeNetwork };
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

  const { address, activeNetwork } = await createEncryptedSession(privateKey);
  console.log("Session encrypted and saved.");
  console.log(`Logged in as ${address}`);
  console.log(`Active network: ${activeNetwork}`);
  console.log(
    "`cmu deploy` will use this key automatically when PRIVATE_KEY is not set.",
  );
}

/**
 * Fetch and display the native token balance of the logged-in wallet.
 * @returns {Promise<void>}
 */
async function runWalletBalance(): Promise<void> {
  const session = await readSession();

  if (!session) {
    throw new Error(
      "no active session.\n" +
        "\x1b[2mhint:\x1b[0m run `cmu wallet login` first.",
    );
  }

  const { getDynamicNetwork } = await import("../utils/network");
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
  const session = await readSession();

  if (!session) {
    throw new Error(
      "no active session.\n" +
        "\x1b[2mhint:\x1b[0m run `cmu wallet login` first.",
    );
  }

  const { getDynamicNetwork } = await import("../utils/network");
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
