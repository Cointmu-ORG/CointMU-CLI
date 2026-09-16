import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { Command } from "commander";
import { printCliError } from "../utils/errors";
import { getSessionFilePath } from "../utils/session";

const EXIT_FAILURE = 1;

/**
 * Prompts for a session password, encrypts the given private key with it and
 * writes the result to .cmu-session.
 *
 * Shared by `wallet login` and `wallet create --login` so both go through one
 * implementation of the encrypt-and-store path. The key is never printed.
 *
 * @param {string} privateKey - The private key to encrypt.
 * @returns {Promise<string>} The address the session belongs to.
 */
async function createEncryptedSession(privateKey: string): Promise<string> {
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

  await writeSessionFile(getSessionFilePath(), {
    address: wallet.address,
    activeNetwork: "local",
    ...encryptSessionKey(password, privateKey),
  });

  return wallet.address;
}

/**
 * Generates a new, secure EVM-compatible wallet.
 * @param {object} options - CLI options.
 * @returns {Promise<void>}
 */
export async function runWalletCreate(
  options: { verbose?: boolean; login?: boolean } = {},
): Promise<void> {
  try {
    const { ethers } = await import("ethers");
    const wallet = ethers.Wallet.createRandom();

    if (options.login) {
      // The generated key goes straight into the encrypted session. Neither it
      // nor the mnemonic is passed to console.log anywhere on this path, so
      // nothing recoverable reaches scrollback or a CI log.
      const address = await createEncryptedSession(wallet.privateKey);
      console.log("New CointMU wallet");
      console.log("===========================");
      console.log(`Address : ${address}`);
      console.log("===========================");
      console.log("Session encrypted and saved.");
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
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m wallet create failed");
    printCliError(error, options.verbose);
    process.exit(EXIT_FAILURE);
  }
}

/**
 * Securely log into a wallet and create an encrypted session.
 * @param {object} options - CLI options.
 * @returns {Promise<void>}
 */
async function runWalletLogin(
  options: { verbose?: boolean } = {},
): Promise<void> {
  try {
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

    const address = await createEncryptedSession(privateKey);
    console.log("Session encrypted and saved.");
    console.log(`Logged in as ${address}`);
    console.log(
      "`cmu deploy` will use this key automatically when PRIVATE_KEY is not set.",
    );
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m wallet login failed");
    printCliError(error, options.verbose);
    process.exit(EXIT_FAILURE);
  }
}

/**
 * Fetch and display the native token balance of the logged-in wallet.
 * @param {object} options - CLI options.
 * @returns {Promise<void>}
 */
async function runWalletBalance(
  options: { verbose?: boolean } = {},
): Promise<void> {
  try {
    const sessionFile = getSessionFilePath();

    if (!existsSync(sessionFile)) {
      throw new Error(
        "no active session.\n" +
          "\x1b[2mhint:\x1b[0m run `cmu wallet login` first.",
      );
    }

    const session = JSON.parse(await readFile(sessionFile, "utf8"));
    const { getDynamicNetwork } = await import("../utils/network");
    const { ethers } = await import("ethers");

    const network = await getDynamicNetwork(session.activeNetwork);
    const provider = new ethers.JsonRpcProvider(network.url);

    console.log(`Connecting to ${network.name} (${network.url})...`);
    const balance = await provider.getBalance(session.address);

    console.log("---------------------------");
    console.log(`Address : ${session.address}`);
    console.log(`Balance : ${ethers.formatEther(balance)} ETH`);
    console.log("---------------------------");
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m wallet balance failed");
    printCliError(error, options.verbose);
    process.exit(EXIT_FAILURE);
  }
}

/**
 * Display the current active wallet session information.
 * @param {object} options - CLI options.
 * @returns {Promise<void>}
 */
async function runWalletInfo(
  options: { verbose?: boolean } = {},
): Promise<void> {
  try {
    const sessionFile = getSessionFilePath();

    if (!existsSync(sessionFile)) {
      throw new Error(
        "no active session.\n" +
          "\x1b[2mhint:\x1b[0m run `cmu wallet login` first.",
      );
    }

    const session = JSON.parse(await readFile(sessionFile, "utf8"));
    const { getDynamicNetwork } = await import("../utils/network");
    const network = await getDynamicNetwork(session.activeNetwork);

    console.log("--- Active session ---");
    console.log(`Address      : ${session.address}`);
    console.log(`Network      : ${network.name}`);
    console.log(`RPC endpoint : ${network.url}`);
    console.log("----------------------");
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m wallet info failed");
    printCliError(error, options.verbose);
    process.exit(EXIT_FAILURE);
  }
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
  .option("-v, --verbose", "Print full stack traces on failure")
  .action(runWalletCreate);

walletCommand
  .command("login")
  .description("Log in and store the key in an encrypted session")
  .option("-v, --verbose", "Print full stack traces on failure")
  .action(runWalletLogin);

walletCommand
  .command("balance")
  .description("Show the native token balance of the logged-in wallet")
  .option("-v, --verbose", "Print full stack traces on failure")
  .action(runWalletBalance);

walletCommand
  .command("info")
  .description("Show the active wallet session")
  .option("-v, --verbose", "Print full stack traces on failure")
  .action(runWalletInfo);
