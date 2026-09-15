import { Command } from "commander";
import { printCliError } from "../utils/errors";
import { getSessionFilePath } from "../utils/session";

const EXIT_FAILURE = 1;

/**
 * Validates that a value is a well-formed RPC endpoint.
 * Only http/https are accepted: every provider in this CLI is an
 * ethers JsonRpcProvider, which cannot speak any other scheme.
 * @param {string} value - The candidate RPC endpoint.
 * @returns {boolean} True if the value is a valid http or https URL.
 */
export function isValidRpcUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Displays the active network configuration.
 * @param {object} options - CLI options.
 * @returns {Promise<void>} Resolves when the info is displayed.
 */
async function runNetworkInfo(
  options: { verbose?: boolean } = {},
): Promise<void> {
  try {
    const fs = (await import("fs-extra")).default || (await import("fs-extra"));
    const sessionFile = getSessionFilePath();

    if (!(await fs.pathExists(sessionFile))) {
      throw new Error(
        "no active session.\n" +
          "\x1b[2mhint:\x1b[0m run `cmu wallet login`, then `cmu network --use <name>`.",
      );
    }

    const session = await fs.readJson(sessionFile);
    if (!session.activeNetwork) {
      throw new Error(
        "no active network in the session.\n" +
          "\x1b[2mhint:\x1b[0m select one with `cmu network --use <name>`.",
      );
    }

    const { loadNetworks } = await import("../utils/networkStorage");
    const networks = await loadNetworks();
    const activeNetwork = networks.find(
      (n: any) => n.name === session.activeNetwork,
    );

    if (!activeNetwork) {
      throw new Error(
        `active network '${session.activeNetwork}' is no longer saved.\n` +
          "\x1b[2mhint:\x1b[0m pick an existing one with `cmu network --use <name>`, or re-add it with `cmu network --save <url> --name <name>`.",
      );
    }

    console.log("--- Active network ---");
    console.log(`Network      : ${activeNetwork.name}`);
    console.log(`RPC endpoint : ${activeNetwork.rpcUrl}`);
    console.log("----------------------");
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m network info failed");

    printCliError(error, options.verbose);

    process.exit(EXIT_FAILURE);
  }
}

/**
 * Pings a network to check connectivity and latency.
 * @param {string} [name] - The name of the network to ping.
 * @param {object} options - CLI options.
 * @returns {Promise<void>} Resolves when the ping is completed.
 */
async function runNetworkPing(
  name?: string,
  options: { verbose?: boolean } = {},
): Promise<void> {
  try {
    const fs = (await import("fs-extra")).default || (await import("fs-extra"));
    const { loadNetworks } = await import("../utils/networkStorage");

    let rpcUrl = "";
    let networkName = "";

    if (name) {
      const networks = await loadNetworks();
      const network = networks.find((n: any) => n.name === name);
      if (!network) {
        throw new Error(
          `network '${name}' is not saved.\n` +
            "\x1b[2mhint:\x1b[0m list saved networks with `cmu network --list`.",
        );
      }
      rpcUrl = network.rpcUrl;
      networkName = network.name;
    } else {
      const sessionFile = getSessionFilePath();
      if (!(await fs.pathExists(sessionFile))) {
        throw new Error(
          "no active session.\n" +
            "\x1b[2mhint:\x1b[0m pass a network name, or run `cmu wallet login` first.",
        );
      }

      const session = await fs.readJson(sessionFile);
      if (!session.activeNetwork) {
        throw new Error(
          "no active network in the session.\n" +
            "\x1b[2mhint:\x1b[0m select one with `cmu network --use <name>`.",
        );
      }

      const networks = await loadNetworks();
      const activeNetwork = networks.find(
        (n: any) => n.name === session.activeNetwork,
      );

      if (!activeNetwork) {
        throw new Error(
          `active network '${session.activeNetwork}' is no longer saved.\n` +
            "\x1b[2mhint:\x1b[0m pick an existing one with `cmu network --use <name>`.",
        );
      }

      rpcUrl = activeNetwork.rpcUrl;
      networkName = activeNetwork.name;
    }

    console.log(`Pinging ${networkName} (${rpcUrl})...`);
    const { ethers } = await import("ethers");
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    const startTime = Date.now();
    const blockNumber = await provider.getBlockNumber();
    const latency = Date.now() - startTime;

    console.log("--- Ping result ---");
    console.log(`Network      : ${networkName}`);
    console.log(`Block number : ${blockNumber}`);
    console.log(`Latency      : ${latency}ms`);
    console.log("-------------------");
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m network ping failed");

    printCliError(error, options.verbose);

    process.exit(EXIT_FAILURE);
  }
}

/**
 * Manages the local RPC networks configuration.
 * @param {object} options - CLI options.
 * @returns {Promise<void>} Resolves when the network management command is completed.
 */
async function runNetworkManage(options: {
  save?: string;
  name?: string;
  use?: string;
  list?: boolean;
  delete?: string;
  verbose?: boolean;
}): Promise<void> {
  try {
    const fs = (await import("fs-extra")).default || (await import("fs-extra"));
    const { loadNetworks, saveNetwork, deleteNetwork } =
      await import("../utils/networkStorage");
    const { writeSessionFile } = await import("../utils/session");
    const sessionFile = getSessionFilePath();

    if (options.save) {
      if (!options.name) {
        throw new Error(
          "--name is required with --save.\n" +
            "\x1b[2mhint:\x1b[0m e.g. `cmu network --save http://127.0.0.1:8585 --name local`.",
        );
      }
      if (!isValidRpcUrl(options.save)) {
        throw new Error(
          `invalid RPC endpoint '${options.save}'.\n` +
            "\x1b[2mhint:\x1b[0m pass a full http:// or https:// URL, e.g. `cmu network --save http://127.0.0.1:8585 --name local`.",
        );
      }

      await saveNetwork(options.name, options.save);
      console.log(`Saved network '${options.name}' (${options.save})`);
      return;
    }

    if (options.delete) {
      const networks = await loadNetworks();
      const targetName = options.delete;
      const network = networks.find((n: any) => n.name === targetName);

      if (!network) {
        throw new Error(
          `network '${targetName}' is not saved.\n` +
            "\x1b[2mhint:\x1b[0m list saved networks with `cmu network --list`.",
        );
      }

      if (await fs.pathExists(sessionFile)) {
        const session = await fs.readJson(sessionFile);
        if (session.activeNetwork === targetName) {
          throw new Error(
            `network '${targetName}' is currently active and cannot be deleted.\n` +
              "\x1b[2mhint:\x1b[0m switch away first with `cmu network --use <name>`.",
          );
        }
      }

      const success = await deleteNetwork(targetName);
      if (success) {
        console.log(`Deleted network '${targetName}'`);
      } else {
        throw new Error(`could not delete network '${targetName}'.`);
      }
      return;
    }

    if (options.use) {
      const networks = await loadNetworks();
      const network = networks.find((n: any) => n.name === options.use);
      if (!network) {
        throw new Error(
          `network '${options.use}' is not saved.\n` +
            "\x1b[2mhint:\x1b[0m list saved networks with `cmu network --list`.",
        );
      }

      if (await fs.pathExists(sessionFile)) {
        const session = await fs.readJson(sessionFile);
        session.activeNetwork = options.use;
        await writeSessionFile(sessionFile, session);
        console.log(`Active network is now ${network.name}`);
      } else {
        throw new Error(
          "no active session.\n" +
            "\x1b[2mhint:\x1b[0m run `cmu wallet login` first.",
        );
      }
      return;
    }

    if (
      options.list ||
      Object.keys(options).length === 0 ||
      (Object.keys(options).length === 1 && options.verbose)
    ) {
      const networks = await loadNetworks();
      let activeNetworkName = "local";

      if (await fs.pathExists(sessionFile)) {
        const session = await fs.readJson(sessionFile);
        if (session.activeNetwork) {
          activeNetworkName = session.activeNetwork;
        }
      }

      console.log("\nSaved networks");
      console.log(
        "==========================================================================",
      );
      console.log("| Active | Name                 | RPC endpoint");
      console.log(
        "--------------------------------------------------------------------------",
      );
      for (const net of networks) {
        const isActive = net.name === activeNetworkName ? "[*]   " : "      ";
        console.log(`| ${isActive} | ${net.name.padEnd(20)} | ${net.rpcUrl}`);
      }
      console.log(
        "==========================================================================\n",
      );
      return;
    }

    console.log("No network option given. Run `cmu network --help` for usage.");
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m network failed");

    printCliError(error, options.verbose);

    process.exit(EXIT_FAILURE);
  }
}

export const networkCommand = new Command("network")
  .description("Manage saved RPC networks")
  .option("-s, --save <url>", "Save a new network or update an existing one")
  .option("-n, --name <name>", "Name of the network to save")
  .option("-u, --use <name>", "Switch the active network")
  .option("-l, --list", "List all saved networks")
  .option("-D, --delete <name>", "Delete a saved network")
  .option("-v, --verbose", "Print full stack traces on failure")
  .action(runNetworkManage);

networkCommand
  .command("info")
  .description("Show the active network")
  .option("-v, --verbose", "Print full stack traces on failure")
  .action(runNetworkInfo);

networkCommand
  .command("ping [name]")
  .description("Ping a network to check connectivity and latency")
  .option("-v, --verbose", "Print full stack traces on failure")
  .action(runNetworkPing);
