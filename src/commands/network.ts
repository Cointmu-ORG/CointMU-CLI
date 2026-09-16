import { existsSync } from "fs";
import { readFile } from "fs/promises";
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
    const sessionFile = getSessionFilePath();

    if (!existsSync(sessionFile)) {
      throw new Error(
        "no active session.\n" +
          "\x1b[2mhint:\x1b[0m run `cmu wallet login`, then `cmu network use <name>`.",
      );
    }

    const session = JSON.parse(await readFile(sessionFile, "utf8"));
    if (!session.activeNetwork) {
      throw new Error(
        "no active network in the session.\n" +
          "\x1b[2mhint:\x1b[0m select one with `cmu network use <name>`.",
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
          "\x1b[2mhint:\x1b[0m pick an existing one with `cmu network use <name>`, or re-add it with `cmu network save <url> --name <name>`.",
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
    const { loadNetworks } = await import("../utils/networkStorage");

    let rpcUrl = "";
    let networkName = "";

    if (name) {
      const networks = await loadNetworks();
      const network = networks.find((n: any) => n.name === name);
      if (!network) {
        throw new Error(
          `network '${name}' is not saved.\n` +
            "\x1b[2mhint:\x1b[0m list saved networks with `cmu network list`.",
        );
      }
      rpcUrl = network.rpcUrl;
      networkName = network.name;
    } else {
      const sessionFile = getSessionFilePath();
      if (!existsSync(sessionFile)) {
        throw new Error(
          "no active session.\n" +
            "\x1b[2mhint:\x1b[0m pass a network name, or run `cmu wallet login` first.",
        );
      }

      const session = JSON.parse(await readFile(sessionFile, "utf8"));
      if (!session.activeNetwork) {
        throw new Error(
          "no active network in the session.\n" +
            "\x1b[2mhint:\x1b[0m select one with `cmu network use <name>`.",
        );
      }

      const networks = await loadNetworks();
      const activeNetwork = networks.find(
        (n: any) => n.name === session.activeNetwork,
      );

      if (!activeNetwork) {
        throw new Error(
          `active network '${session.activeNetwork}' is no longer saved.\n` +
            "\x1b[2mhint:\x1b[0m pick an existing one with `cmu network use <name>`.",
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
 * Saves a network under a name, or updates the endpoint of an existing one.
 * @param {string} url - The RPC endpoint to save.
 * @param {object} options - CLI options; `name` is required.
 * @returns {Promise<void>} Resolves when the network is saved.
 */
async function runNetworkSave(
  url: string,
  options: { name?: string; verbose?: boolean } = {},
): Promise<void> {
  try {
    if (!options.name) {
      throw new Error(
        "--name is required.\n" +
          "\x1b[2mhint:\x1b[0m e.g. `cmu network save http://127.0.0.1:8585 --name local`.",
      );
    }
    if (!isValidRpcUrl(url)) {
      throw new Error(
        `invalid RPC endpoint '${url}'.\n` +
          "\x1b[2mhint:\x1b[0m pass a full http:// or https:// URL, e.g. `cmu network save http://127.0.0.1:8585 --name local`.",
      );
    }

    const { saveNetwork } = await import("../utils/networkStorage");
    await saveNetwork(options.name, url);
    console.log(`Saved network '${options.name}' (${url})`);
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m network save failed");

    printCliError(error, options.verbose);

    process.exit(EXIT_FAILURE);
  }
}

/**
 * Deletes a saved network, refusing to remove the one currently in use.
 * @param {string} name - The network to delete.
 * @param {object} options - CLI options.
 * @returns {Promise<void>} Resolves when the network is deleted.
 */
async function runNetworkDelete(
  name: string,
  options: { verbose?: boolean } = {},
): Promise<void> {
  try {
    const { loadNetworks, deleteNetwork } =
      await import("../utils/networkStorage");

    const networks = await loadNetworks();
    if (!networks.some((n: any) => n.name === name)) {
      throw new Error(
        `network '${name}' is not saved.\n` +
          "\x1b[2mhint:\x1b[0m list saved networks with `cmu network list`.",
      );
    }

    const sessionFile = getSessionFilePath();
    if (existsSync(sessionFile)) {
      const session = JSON.parse(await readFile(sessionFile, "utf8"));
      if (session.activeNetwork === name) {
        throw new Error(
          `network '${name}' is currently active and cannot be deleted.\n` +
            "\x1b[2mhint:\x1b[0m switch away first with `cmu network use <name>`.",
        );
      }
    }

    if (!(await deleteNetwork(name))) {
      throw new Error(`could not delete network '${name}'.`);
    }
    console.log(`Deleted network '${name}'`);
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m network delete failed");

    printCliError(error, options.verbose);

    process.exit(EXIT_FAILURE);
  }
}

/**
 * Switches the active network recorded in the session.
 * @param {string} name - The network to activate.
 * @param {object} options - CLI options.
 * @returns {Promise<void>} Resolves when the active network is switched.
 */
async function runNetworkUse(
  name: string,
  options: { verbose?: boolean } = {},
): Promise<void> {
  try {
    const { loadNetworks } = await import("../utils/networkStorage");
    const { writeSessionFile } = await import("../utils/session");

    const networks = await loadNetworks();
    const network = networks.find((n: any) => n.name === name);
    if (!network) {
      throw new Error(
        `network '${name}' is not saved.\n` +
          "\x1b[2mhint:\x1b[0m list saved networks with `cmu network list`.",
      );
    }

    const sessionFile = getSessionFilePath();
    if (!existsSync(sessionFile)) {
      throw new Error(
        "no active session.\n" +
          "\x1b[2mhint:\x1b[0m run `cmu wallet login` first.",
      );
    }

    const session = JSON.parse(await readFile(sessionFile, "utf8"));
    session.activeNetwork = name;
    await writeSessionFile(sessionFile, session);
    console.log(`Active network is now ${network.name}`);
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m network use failed");

    printCliError(error, options.verbose);

    process.exit(EXIT_FAILURE);
  }
}

/**
 * Lists every saved network, marking the active one.
 * @param {object} options - CLI options.
 * @returns {Promise<void>} Resolves when the table is printed.
 */
async function runNetworkList(
  options: { verbose?: boolean } = {},
): Promise<void> {
  try {
    const { loadNetworks } = await import("../utils/networkStorage");

    const networks = await loadNetworks();
    let activeNetworkName = "local";

    const sessionFile = getSessionFilePath();
    if (existsSync(sessionFile)) {
      const session = JSON.parse(await readFile(sessionFile, "utf8"));
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
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m network list failed");

    printCliError(error, options.verbose);

    process.exit(EXIT_FAILURE);
  }
}

/**
 * Maps the pre-1.4 flag form onto the subcommands that replaced it.
 *
 * `cmu network` with no flags has always listed the saved networks, so it still
 * does. Anything else prints a deprecation notice and runs the same handler the
 * subcommand would; the flags are removed in 2.0.0.
 *
 * @param {object} options - CLI options from the legacy flags.
 * @returns {Promise<void>} Resolves when the mapped handler completes.
 */
async function runNetworkLegacy(options: {
  save?: string;
  name?: string;
  use?: string;
  list?: boolean;
  delete?: string;
  verbose?: boolean;
}): Promise<void> {
  const deprecated = (flag: string, replacement: string) => {
    console.warn(
      `\n\x1b[33mwarning:\x1b[0m \`cmu network ${flag}\` is deprecated and will be removed in 2.0.0`,
    );
    console.warn(
      `\x1b[2mhint:\x1b[0m use \`cmu network ${replacement}\` instead.\n`,
    );
  };

  if (options.save !== undefined) {
    deprecated("--save", "save <url> --name <name>");
    return runNetworkSave(options.save, options);
  }
  if (options.delete !== undefined) {
    deprecated("--delete", "delete <name>");
    return runNetworkDelete(options.delete, options);
  }
  if (options.use !== undefined) {
    deprecated("--use", "use <name>");
    return runNetworkUse(options.use, options);
  }
  if (options.list) {
    deprecated("--list", "list");
  }
  return runNetworkList(options);
}

export const networkCommand = new Command("network")
  .description("Manage saved RPC networks")
  // Deprecated in 1.4.0, removed in 2.0.0; see runNetworkLegacy().
  .option("-s, --save <url>", "Deprecated: use `cmu network save`")
  .option("-n, --name <name>", "Name of the network to save")
  .option("-u, --use <name>", "Deprecated: use `cmu network use`")
  .option("-l, --list", "Deprecated: use `cmu network list`")
  .option("-D, --delete <name>", "Deprecated: use `cmu network delete`")
  .option("-v, --verbose", "Print full stack traces on failure")
  .action(runNetworkLegacy);

networkCommand
  .command("save <url>")
  .description("Save a new network or update an existing one")
  .option("-n, --name <name>", "Name to save the network under")
  .option("-v, --verbose", "Print full stack traces on failure")
  // The deprecated root flags still declare -n/--name, and commander binds a
  // flag to the command that declares it even when it appears after a
  // subcommand name. Merge the root's options so `network save <url> --name x`
  // sees the name wherever commander parked it; runNetworkSave() reports a
  // missing name itself, with a hint the built-in required check cannot give.
  .action((url, options, command) =>
    runNetworkSave(url, { ...command.parent.opts(), ...options }),
  );

networkCommand
  .command("list")
  .description("List all saved networks")
  .option("-v, --verbose", "Print full stack traces on failure")
  .action(runNetworkList);

networkCommand
  .command("use <name>")
  .description("Switch the active network")
  .option("-v, --verbose", "Print full stack traces on failure")
  .action(runNetworkUse);

networkCommand
  .command("delete <name>")
  .description("Delete a saved network")
  .option("-v, --verbose", "Print full stack traces on failure")
  .action(runNetworkDelete);

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
