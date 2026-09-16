import { Command } from "commander";
import { fail } from "../utils/errors";
import {
  ACCOUNT_COUNT,
  bootHardhat,
  silenceHardhatNoise,
} from "../utils/hardhat";
import { LOCAL_CHAIN_ID, LOCAL_PORT } from "../utils/defaults";

const DEFAULT_HOST = "127.0.0.1";
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
async function runNodeConnect(options: {
  network?: string;
  verbose?: boolean;
}): Promise<void> {
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
  verbose?: boolean;
}): Promise<void> {
  const isVerbose = options.verbose;
  const { killPort } = await import("../utils/process");
  const parsedPort = parseInt(options.port, 10);
  const port = !isNaN(parsedPort) ? parsedPort : LOCAL_PORT;

  if (isNaN(port) || port <= 0 || port > MAX_PORT) {
    throw new Error(
      `invalid port '${options.port}'.\n` +
        `\x1b[2mhint:\x1b[0m pass a port between 1 and ${MAX_PORT}, e.g. \`cmu node start -p ${LOCAL_PORT}\`.`,
    );
  }

  warnOnNonLoopbackHost(options.host);

  await killPort(port);

  const console_ = silenceHardhatNoise({
    verbose: isVerbose,
    // Hardhat only complains about this when driven from outside a project,
    // which is exactly how `cmu node start` drives it.
    extraPatterns: ["You are not inside a Hardhat project"],
    onLog: (msg, _args, originalLog) => {
      // Reformat the provider's RPC chatter, or drop it when --log is off.
      if (
        msg.includes("eth_") ||
        msg.includes("net_") ||
        msg.includes("web3_")
      ) {
        if (options.log) {
          const match = msg.match(/(eth_|net_|web3_)[a-zA-Z0-9_]+/);
          originalLog(`\x1b[2mrpc:\x1b[0m ${match ? match[0] : msg.trim()}`);
        }
        return true;
      }

      // Suppress hardhat's own startup banner; we print our own below.
      return (
        msg.includes("Started HTTP and WebSocket JSON-RPC server at") ||
        msg.includes("Account #") ||
        msg.includes("Private Key:") ||
        msg.includes("WARNING: These accounts, and their private keys") ||
        msg.includes(
          "Any funds sent to them on Mainnet or any other live network WILL BE LOST.",
        ) ||
        msg.includes("hardhat_")
      );
    },
  });
  const originalConsoleLog = console_.log;

  const { hre, mnemonic: resolvedMnemonic } = await bootHardhat({
    mnemonic: options.mnemonic,
    loggingEnabled: !!options.log || !!isVerbose,
  });

  const host = options.host;

  originalConsoleLog(`\nCointMU DevNet listening on http://${host}:${port}`);
  originalConsoleLog(`Chain ID: ${LOCAL_CHAIN_ID}\n`);
  originalConsoleLog(`Mnemonic: ${resolvedMnemonic}`);
  originalConsoleLog(
    `\x1b[33mwarning:\x1b[0m development mnemonic - never use it on a live network.\n`,
  );
  originalConsoleLog("\nPre-funded developer accounts (100 ETH each):");

  const { ethers } = await import("ethers");
  let index = 0;
  const mnemonicObj = ethers.Mnemonic.fromPhrase(resolvedMnemonic);
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
    process.exit(0);
  });

  // Run the hardhat node natively
  await hre.tasks.getTask("node").run({
    hostname: host,
    port: port,
  });
}

export const nodeCommand = new Command("node").description(
  "Manage the local EVM node",
);

nodeCommand
  .command("connect")
  .description("Ping the configured RPC endpoint")
  .option("-n, --network <name>", "Network to connect to")
  .action((options, command) => {
    const opts = command.optsWithGlobals();
    return runNodeConnect(opts).catch(
      fail(
        "node connect",
        opts,
        "start a local node with `cmu node start`, or check the endpoint with `cmu network info`.",
      ),
    );
  });

nodeCommand
  .command("start")
  .description("Start a local DevNet with pre-funded accounts")
  .option("--host <host>", "Host to bind the server to", DEFAULT_HOST)
  .option(
    "-p, --port <number>",
    "Port to bind the local EVM node to",
    String(LOCAL_PORT),
  )
  .option(
    "-m, --mnemonic <phrase>",
    "12-word mnemonic for deterministic accounts",
  )
  .option("-l, --log", "Log RPC calls as they arrive")
  .action((options, command) => {
    // runNodeStart reads verbose itself, for the Hardhat log filter.
    const opts = command.optsWithGlobals();
    return runNodeStart(opts).catch(fail("node start", opts));
  });
