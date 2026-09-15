import { Command } from "commander";
import { printCliError } from "../utils/errors";

const EXIT_FAILURE = 1;
const MINER_THREAD_COUNT = 1;
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
 * Starts the mining process on the active network.
 * @param {object} options - CLI options.
 * @returns {Promise<void>} Resolves when mining is started successfully.
 */
async function runMineStart(
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

    console.log(`Setting etherbase to ${session.address}...`);
    await provider.send("miner_setEtherbase", [session.address]);

    console.log(`Starting miner on ${network.name}...`);
    await provider.send("miner_start", [MINER_THREAD_COUNT]);

    console.log("Mining started.");
    console.log(`Rewards are routed to ${session.address}`);
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m mine start failed");

    printCliError(error, options.verbose);

    process.exit(EXIT_FAILURE);
  }
}

/**
 * Stops the mining process on the active network.
 * @param {object} options - CLI options.
 * @returns {Promise<void>} Resolves when mining is stopped successfully.
 */
async function runMineStop(options: { verbose?: boolean } = {}): Promise<void> {
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

    console.log(`Stopping miner on ${network.name}...`);
    await provider.send("miner_stop", []);

    console.log("Mining stopped.");
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m mine stop failed");

    printCliError(error, options.verbose);

    process.exit(EXIT_FAILURE);
  }
}

export const mineCommand = new Command("mine").description(
  "Control mining on the active network",
);

mineCommand
  .command("start")
  .description("Start mining with the logged-in wallet")
  .option("-v, --verbose", "Print full stack traces on failure")
  .action(runMineStart);

mineCommand
  .command("stop")
  .description("Stop mining")
  .option("-v, --verbose", "Print full stack traces on failure")
  .action(runMineStop);
