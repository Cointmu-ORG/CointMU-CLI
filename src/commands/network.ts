import { Command } from "commander";
import { fail } from "../utils/errors";
import { getSessionFilePath, readSession } from "../utils/session";

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
 * @returns {Promise<void>} Resolves when the info is displayed.
 */
async function runNetworkInfo(): Promise<void> {
  const { activeNetwork } = await import("../utils/network");
  const network = await activeNetwork();

  console.log("--- Active network ---");
  console.log(`Network      : ${network.name}`);
  console.log(`RPC endpoint : ${network.rpcUrl}`);
  console.log("----------------------");
}

/**
 * Pings a network to check connectivity and latency.
 * @param {string} [name] - The name of the network to ping.
 * @returns {Promise<void>} Resolves when the ping is completed.
 */
async function runNetworkPing(name?: string): Promise<void> {
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
    const { activeNetwork } = await import("../utils/network");
    const network = await activeNetwork(
      "pass a network name, or run `cmu wallet login` first.",
    );
    rpcUrl = network.rpcUrl;
    networkName = network.name;
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
}

/**
 * Deletes a saved network, refusing to remove the one currently in use.
 * @param {string} name - The network to delete.
 * @returns {Promise<void>} Resolves when the network is deleted.
 */
async function runNetworkDelete(name: string): Promise<void> {
  const { loadNetworks, deleteNetwork } =
    await import("../utils/networkStorage");

  const networks = await loadNetworks();
  if (!networks.some((n: any) => n.name === name)) {
    throw new Error(
      `network '${name}' is not saved.\n` +
        "\x1b[2mhint:\x1b[0m list saved networks with `cmu network list`.",
    );
  }

  if ((await readSession())?.activeNetwork === name) {
    throw new Error(
      `network '${name}' is currently active and cannot be deleted.\n` +
        "\x1b[2mhint:\x1b[0m switch away first with `cmu network use <name>`.",
    );
  }

  if (!(await deleteNetwork(name))) {
    throw new Error(`could not delete network '${name}'.`);
  }
  console.log(`Deleted network '${name}'`);
}

/**
 * Switches the active network recorded in the session.
 * @param {string} name - The network to activate.
 * @returns {Promise<void>} Resolves when the active network is switched.
 */
async function runNetworkUse(name: string): Promise<void> {
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

  const session = await readSession();
  if (!session) {
    throw new Error(
      "no active session.\n" +
        "\x1b[2mhint:\x1b[0m run `cmu wallet login` first.",
    );
  }

  session.activeNetwork = name;
  await writeSessionFile(getSessionFilePath(), session);
  console.log(`Active network is now ${network.name}`);
}

/**
 * Lists every saved network, marking the active one.
 * @returns {Promise<void>} Resolves when the table is printed.
 */
async function runNetworkList(): Promise<void> {
  const { loadNetworks } = await import("../utils/networkStorage");

  const networks = await loadNetworks();
  const { activeNetworkName } = await import("../utils/network");
  const activeName = await activeNetworkName();

  console.log("\nSaved networks");
  console.log(
    "==========================================================================",
  );
  console.log("| Active | Name                 | RPC endpoint");
  console.log(
    "--------------------------------------------------------------------------",
  );
  for (const net of networks) {
    const isActive = net.name === activeName ? "[*]   " : "      ";
    console.log(`| ${isActive} | ${net.name.padEnd(20)} | ${net.rpcUrl}`);
  }
  console.log(
    "==========================================================================\n",
  );
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
    return runNetworkDelete(options.delete);
  }
  if (options.use !== undefined) {
    deprecated("--use", "use <name>");
    return runNetworkUse(options.use);
  }
  if (options.list) {
    deprecated("--list", "list");
  }
  return runNetworkList();
}

export const networkCommand = new Command("network")
  .description("Manage saved RPC networks")
  // Deprecated in 1.4.0, removed in 2.0.0; see runNetworkLegacy().
  .option("-s, --save <url>", "Deprecated: use `cmu network save`")
  .option("-n, --name <name>", "Name of the network to save")
  .option("-u, --use <name>", "Deprecated: use `cmu network use`")
  .option("-l, --list", "Deprecated: use `cmu network list`")
  .option("-D, --delete <name>", "Deprecated: use `cmu network delete`")
  .action((options, command) =>
    runNetworkLegacy(options).catch(fail("network", command.optsWithGlobals())),
  );

networkCommand
  .command("save <url>")
  .description("Save a new network or update an existing one")
  .option("-n, --name <name>", "Name to save the network under")
  // The deprecated root flags still declare -n/--name, and commander binds a
  // flag to the command that declares it even when it appears after a
  // subcommand name. Merge the root's options so `network save <url> --name x`
  // sees the name wherever commander parked it; runNetworkSave() reports a
  // missing name itself, with a hint the built-in required check cannot give.
  .action((url, options, command) => {
    const merged = { ...command.parent.opts(), ...options };
    return runNetworkSave(url, merged).catch(
      fail("network save", command.optsWithGlobals()),
    );
  });

networkCommand
  .command("list")
  .description("List all saved networks")
  .action((options, command) =>
    runNetworkList().catch(fail("network list", command.optsWithGlobals())),
  );

networkCommand
  .command("use <name>")
  .description("Switch the active network")
  .action((name, options, command) =>
    runNetworkUse(name).catch(fail("network use", command.optsWithGlobals())),
  );

networkCommand
  .command("delete <name>")
  .description("Delete a saved network")
  .action((name, options, command) =>
    runNetworkDelete(name).catch(
      fail("network delete", command.optsWithGlobals()),
    ),
  );

networkCommand
  .command("info")
  .description("Show the active network")
  .action((options, command) =>
    runNetworkInfo().catch(fail("network info", command.optsWithGlobals())),
  );

networkCommand
  .command("ping [name]")
  .description("Ping a network to check connectivity and latency")
  .action((name, options, command) =>
    runNetworkPing(name).catch(fail("network ping", command.optsWithGlobals())),
  );
