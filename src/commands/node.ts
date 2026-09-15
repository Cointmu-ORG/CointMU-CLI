import { Command } from "commander";
import { printCliError } from "../utils/errors";

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8585;
const DEFAULT_CHAIN_ID = 1912;
const ACCOUNT_COUNT = 10;
const ACCOUNT_BALANCE = "100000000000000000000";
const MAX_PORT = 65535;

const LOOPBACK_HOSTS = ["localhost", "::1", "[::1]", "::ffff:127.0.0.1"];

/**
 * Reports whether a bind host keeps the DevNet reachable only from this machine.
 * @param {string} host - The host the node will bind to.
 * @returns {boolean} True for loopback addresses and localhost.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    LOOPBACK_HOSTS.includes(normalized) ||
    /^127(\.\d{1,3}){3}$/.test(normalized)
  );
}

/**
 * Warns, before the node binds, that a non-loopback host exposes the dev RPC
 * endpoint and the private keys this command is about to print. Not a gate:
 * binding to the LAN is a legitimate way to test from another device.
 * @param {string} host - The host the node will bind to.
 * @returns {void}
 */
export function warnOnNonLoopbackHost(host: string): void {
  if (isLoopbackHost(host)) return;

  console.log(
    `\n\x1b[33mwarning:\x1b[0m --host ${host} binds the DevNet to a non-loopback address`,
  );
  console.log(
    "    The RPC endpoint becomes reachable from your network, and the private keys",
  );
  console.log(
    `    of the ${ACCOUNT_COUNT} pre-funded accounts are printed below in plain text. Anyone who`,
  );
  console.log(
    "    can reach this machine can then drive the node and spend those accounts.",
  );
  console.log(
    `\x1b[2mhint:\x1b[0m omit --host to bind ${DEFAULT_HOST} unless another device really needs access.\n`,
  );
}

/**
 * Pings the configured RPC endpoint to test connectivity.
 * @param {object} options - CLI options.
 * @returns {Promise<void>} Resolves when connection succeeds.
 */
async function runNodeConnect(options: { network?: string }): Promise<void> {
  const isVerbose = nodeCommand.opts().verbose;
  try {
    const { getDynamicNetwork } = await import("../utils/network");
    const { ethers } = await import("ethers");

    const networkConfig = await getDynamicNetwork(options.network);
    const rpcUrl = networkConfig.url;

    console.log(`Pinging ${rpcUrl}...`);
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const network = await provider.getNetwork();
    const blockNumber = await provider.getBlockNumber();

    console.log("Connected to the CointMU node.");
    console.log(`Network      : ${network.name}`);
    console.log(`Chain ID     : ${network.chainId}`);
    console.log(`Block number : ${blockNumber}`);
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m node connect failed");

    printCliError(error, isVerbose);

    console.error(
      "\x1b[2mhint:\x1b[0m start a local node with `cmu node start`, or check the endpoint with `cmu network info`.",
    );

    process.exit(EXIT_FAILURE);
  }
}

/**
 * Starts a local development network with pre-funded accounts.
 * @param {object} options - CLI options.
 * @returns {Promise<void>} Resolves when the dev node shuts down.
 */
async function runNodeStart(options: {
  host: string;
  port: string;
  mnemonic?: string;
  log?: boolean;
}): Promise<void> {
  const isVerbose = nodeCommand.opts().verbose;
  try {
    const { killPort } = await import("../utils/process");
    const parsedPort = parseInt(options.port, 10);
    const port = !isNaN(parsedPort) ? parsedPort : DEFAULT_PORT;

    if (isNaN(port) || port <= 0 || port > MAX_PORT) {
      throw new Error(
        `invalid port '${options.port}'.\n` +
          `\x1b[2mhint:\x1b[0m pass a port between 1 and ${MAX_PORT}, e.g. \`cmu node start -p 8585\`.`,
      );
    }

    warnOnNonLoopbackHost(options.host);

    await killPort(port);

    const suppressWarning = (args: any[]) => {
      if (isVerbose) return false;
      const msg = args.join(" ");
      return (
        msg.includes("uws_win32") ||
        msg.includes("Falling back to a NodeJS implementation") ||
        msg.includes("This version of \u00B5WS") ||
        msg.includes("This version of") ||
        msg.includes("uws-js-unofficial") ||
        msg.includes("Require stack:") ||
        msg.includes("Cannot find module") ||
        msg.includes("You are not inside a Hardhat project")
      );
    };

    const originalConsoleError = console.error;
    console.error = (...args: any[]) => {
      if (suppressWarning(args)) return;
      originalConsoleError(...args);
    };

    const originalConsoleWarn = console.warn;
    console.warn = (...args: any[]) => {
      if (suppressWarning(args)) return;
      originalConsoleWarn(...args);
    };

    const originalConsoleLog = console.log;

    const { ethers } = await import("ethers");
    const resolvedMnemonic =
      options.mnemonic || ethers.Wallet.createRandom().mnemonic?.phrase;

    const host = options.host;

    console.log = (...args: any[]) => {
      if (suppressWarning(args)) return;

      const msg = args.join(" ");

      // Intercept and format RPC logs if logging is enabled
      if (
        msg.includes("eth_") ||
        msg.includes("net_") ||
        msg.includes("web3_")
      ) {
        if (options.log) {
          const match = msg.match(/(eth_|net_|web3_)[a-zA-Z0-9_]+/);
          if (match) {
            originalConsoleLog(`\x1b[2mrpc:\x1b[0m ${match[0]}`);
          } else {
            originalConsoleLog(`\x1b[2mrpc:\x1b[0m ${msg.trim()}`);
          }
        }
        return;
      }

      // Suppress hardhat node default startup output to maintain our exact format
      if (
        msg.includes("Started HTTP and WebSocket JSON-RPC server at") ||
        msg.includes("Account #") ||
        msg.includes("Private Key:") ||
        msg.includes("WARNING: These accounts, and their private keys") ||
        msg.includes(
          "Any funds sent to them on Mainnet or any other live network WILL BE LOST.",
        ) ||
        msg.includes("hardhat_")
      ) {
        return;
      }

      originalConsoleLog(...args);
    };

    // Initialize Hardhat programmatically
    const importDynamic = new Function(
      "modulePath",
      "return import(modulePath)",
    );
    const hre =
      (await importDynamic("hardhat")).default ||
      (await importDynamic("hardhat"));

    if (!hre.config.networks) hre.config.networks = {};
    if (!hre.config.networks.hardhat)
      hre.config.networks.hardhat = { type: "hardhat" } as any;

    // Pass chainId, mnemonic, and pre-funded accounts natively to Hardhat provider configuration
    hre.config.networks.hardhat.chainId = DEFAULT_CHAIN_ID;
    hre.config.networks.hardhat.accounts = {
      mnemonic: resolvedMnemonic,
      accountsBalance: ACCOUNT_BALANCE,
      count: ACCOUNT_COUNT,
    };

    // Enable internal hardhat logging so we can intercept it, unless we are totally quiet
    hre.config.networks.hardhat.loggingEnabled = !!options.log || !!isVerbose;

    originalConsoleLog(`\nCointMU DevNet listening on http://${host}:${port}`);
    originalConsoleLog(`Chain ID: ${DEFAULT_CHAIN_ID}\n`);
    originalConsoleLog(`Mnemonic: ${resolvedMnemonic}`);
    originalConsoleLog(
      `\x1b[33mwarning:\x1b[0m development mnemonic - never use it on a live network.\n`,
    );
    originalConsoleLog("\nPre-funded developer accounts (100 ETH each):");

    let index = 0;
    const mnemonicObj = ethers.Mnemonic.fromPhrase(resolvedMnemonic!);
    for (let i = 0; i < ACCOUNT_COUNT; i++) {
      const wallet = ethers.HDNodeWallet.fromMnemonic(
        mnemonicObj,
        `m/44'/60'/0'/0/${i}`,
      );
      originalConsoleLog(`\nAccount #${index}`);
      originalConsoleLog(`Address     : ${wallet.address}`);
      originalConsoleLog(`Private key : ${wallet.privateKey}`);
      index++;
    }
    originalConsoleLog("\n");

    process.on("SIGINT", () => {
      originalConsoleLog("\nStopping the CointMU DevNet...");
      originalConsoleLog("CointMU DevNet stopped.");
      process.exit(EXIT_SUCCESS);
    });

    // Run the hardhat node natively
    await hre.tasks.getTask("node").run({
      hostname: host,
      port: port,
    });
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m node start failed");

    printCliError(error, isVerbose);

    process.exit(EXIT_FAILURE);
  }
}

export const nodeCommand = new Command("node")
  .description("Manage the local EVM node")
  .option("-v, --verbose", "Enable verbose logging for all node commands");

nodeCommand
  .command("connect")
  .description("Ping the configured RPC endpoint")
  .option("-n, --network <name>", "Network to connect to")
  .action(runNodeConnect);

nodeCommand
  .command("start")
  .description("Start a local DevNet with pre-funded accounts")
  .option("--host <host>", "Host to bind the server to", DEFAULT_HOST)
  .option(
    "-p, --port <number>",
    "Port to bind the local EVM node to",
    String(DEFAULT_PORT),
  )
  .option(
    "-m, --mnemonic <phrase>",
    "12-word mnemonic for deterministic accounts",
  )
  .option("-l, --log", "Log RPC calls as they arrive")
  .action(runNodeStart);
