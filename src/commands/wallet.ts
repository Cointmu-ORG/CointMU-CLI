import { Command } from "commander";

const EXIT_FAILURE = 1;
const SESSION_FILE_NAME = ".cmu-session";

/**
 * Retrieves the session file path lazily.
 * @returns {string} The absolute path to the session file.
 */
function getSessionFilePath(): string {
  const path = require("path");
  return path.resolve(process.cwd(), SESSION_FILE_NAME);
}

/**
 * Generates a new, secure EVM-compatible wallet.
 * @param {object} options - CLI options.
 * @returns {Promise<void>}
 */
async function runWalletCreate(
  options: { verbose?: boolean } = {},
): Promise<void> {
  try {
    const { ethers } = await import("ethers");
    const wallet = ethers.Wallet.createRandom();
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
    console.log("To start an encrypted local session with this wallet, run:");
    console.log("  cmu wallet login");
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m wallet create failed");
    if (options.verbose) {
      console.error(error);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
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
    const { encryptSessionKey, validatePasswordStrength, writeSessionFile } =
      await import("../utils/session");

    const answers = await inquirer.prompt([
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
      {
        type: "password",
        name: "password",
        message: "New session password:",
        mask: "*",
        validate: validatePasswordStrength,
      },
    ]);

    const wallet = new ethers.Wallet(answers.privateKey);

    const sessionData = {
      address: wallet.address,
      activeNetwork: "local",
      ...encryptSessionKey(answers.password, answers.privateKey),
    };

    const sessionFile = getSessionFilePath();
    await writeSessionFile(sessionFile, sessionData);
    console.log("Session encrypted and saved.");
    console.log(`Logged in as ${wallet.address}`);
    console.log(
      "`cmu deploy` will use this key automatically when PRIVATE_KEY is not set.",
    );
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m wallet login failed");
    if (options.verbose) {
      console.error(error);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
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
    const fs = (await import("fs-extra")).default || (await import("fs-extra"));
    const sessionFile = getSessionFilePath();

    if (!(await fs.pathExists(sessionFile))) {
      throw new Error(
        "no active session.\n" +
          "\x1b[2mhint:\x1b[0m run `cmu wallet login` first.",
      );
    }

    const session = await fs.readJson(sessionFile);
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
    if (options.verbose) {
      console.error(error);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
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
    const fs = (await import("fs-extra")).default || (await import("fs-extra"));
    const sessionFile = getSessionFilePath();

    if (!(await fs.pathExists(sessionFile))) {
      throw new Error(
        "no active session.\n" +
          "\x1b[2mhint:\x1b[0m run `cmu wallet login` first.",
      );
    }

    const session = await fs.readJson(sessionFile);
    const { getDynamicNetwork } = await import("../utils/network");
    const network = await getDynamicNetwork(session.activeNetwork);

    console.log("--- Active session ---");
    console.log(`Address      : ${session.address}`);
    console.log(`Network      : ${network.name}`);
    console.log(`RPC endpoint : ${network.url}`);
    console.log("----------------------");
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m wallet info failed");
    if (options.verbose) {
      console.error(error);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(EXIT_FAILURE);
  }
}

export const walletCommand = new Command("wallet").description(
  "Manage wallets and encrypted sessions",
);

walletCommand
  .command("create")
  .description("Generate a new EVM-compatible wallet")
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
