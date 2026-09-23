import type { Block } from "ethers";
import { Command } from "commander";
import { fail } from "../utils/errors";
import { getDeployNetwork } from "../utils/network";
import { confirmProjectTrust, findProjectConfig } from "../utils/trust";
import { pingNetwork } from "./deploy";

interface ExplorerOptions {
  network?: string;
  /** Commander hands over the raw string; parseBlockNumber() validates it. */
  block?: string;
  contract?: string;
  verbose?: boolean;
  yes?: boolean;
}

/**
 * Turns the --block argument into a block number.
 *
 * Commander does no numeric validation, and ethers would forward a bad value
 * to the node as a malformed quantity, so the mistake has to be caught here to
 * come back as something readable. Hex conversion is deliberately not done:
 * provider.getBlock() takes a decimal number and encodes it itself.
 *
 * @param {string} raw - The value passed to --block.
 * @returns {number} The block number.
 * @throws {Error} When the value is not a non-negative integer.
 */
export function parseBlockNumber(raw: string): number {
  const text = String(raw).trim();
  // Anything but digits: rejects "", "-1", "1.5", "0x2a", "abc" and "1e3" in
  // one test, rather than letting Number() coerce them into surprises.
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Error(
      `'${raw}' is not a valid block number.\n` +
        "\x1b[2mhint:\x1b[0m pass a non-negative whole number in decimal, e.g. `cmu explorer --block 42`.",
    );
  }
  return Number(text);
}

/**
 * Renders a block as the report the command prints.
 *
 * @param {Block} block - The block, as ethers returned it.
 * @param {string} networkName - The network it was read from.
 * @returns {string} The printable report.
 */
export function formatBlock(block: Block, networkName: string): string {
  // A zero gasLimit is not a real chain, but dividing by it would print NaN%
  // over a block the user can see is otherwise fine.
  const used =
    block.gasLimit > 0n
      ? ` (${(Number((block.gasUsed * 10000n) / block.gasLimit) / 100).toFixed(2)}%)`
      : "";

  return (
    `\n--- Block ${block.number} on '${networkName}' ---\n` +
    `Hash         : ${block.hash}\n` +
    `Parent       : ${block.parentHash}\n` +
    // The unix value is kept alongside: the readable form is for the human,
    // the integer is what anything else in the toolchain speaks.
    `Timestamp    : ${new Date(block.timestamp * 1000).toISOString()} (${block.timestamp})\n` +
    `Transactions : ${block.transactions.length}\n` +
    `Gas used     : ${block.gasUsed} / ${block.gasLimit}${used}\n` +
    `Validator    : ${block.miner}\n`
  );
}

/**
 * Renders a contract lookup.
 *
 * Empty bytecode is a result, not a failure: "0x" is exactly how the node says
 * an address holds no contract, and saying so is the answer the user asked
 * for. Only an unreachable node or an RPC error is an error here, which is
 * what keeps the two distinguishable by exit code as well as by wording.
 *
 * @param {string} address - The queried address.
 * @param {string} code - The result of eth_getCode.
 * @param {bigint} balance - The result of eth_getBalance, in wei.
 * @param {string} networkName - The network it was read from.
 * @returns {string} The printable report.
 */
export function formatContract(
  address: string,
  code: string,
  balance: bigint,
  networkName: string,
): string {
  const { formatEther } = require("ethers");
  const empty = !code || code === "0x";
  const bytecode = empty
    ? "none - not a contract (an ordinary account, or an unused address)"
    : `${(code.length - 2) / 2} bytes`;

  return (
    `\n--- Address on '${networkName}' ---\n` +
    `Address      : ${address}\n` +
    `Bytecode     : ${bytecode}\n` +
    `Balance      : ${formatEther(balance)} (${balance} wei)\n`
  );
}

/**
 * Runs one explorer query.
 *
 * Never calls process.exit() itself, following runConsole(); the single exit
 * lives in the command handler below.
 *
 * @param {ExplorerOptions} options - CLI options.
 * @returns {Promise<void>} Resolves once the result is printed.
 * @throws {Error} When the flags are wrong, the project is not trusted, the
 *   network cannot be resolved or reached, or the block does not exist.
 */
export async function runExplorer(
  options: ExplorerOptions = {},
): Promise<void> {
  const { block, contract } = options;
  // Both or neither. Two unrelated lookups in one invocation would print two
  // stapled reports, and silently doing nothing when neither flag is given is
  // worse than saying so.
  if ((block === undefined) === (contract === undefined)) {
    throw new Error(
      "exactly one of --block <number> or --contract <address> is required.\n" +
        "\x1b[2mhint:\x1b[0m `cmu explorer --block 42` or `cmu explorer --contract 0x...`.",
    );
  }

  const { ethers } = await import("ethers");

  // Validated before the trust gate: a malformed flag should not first ask the
  // user to trust the project for a command that was never going to run.
  const blockNumber = block === undefined ? undefined : parseBlockNumber(block);
  // ethers treats a non-address string as a possible ENS name and resolves it
  // asynchronously, so without this the mistake surfaces as a connection error
  // from somewhere else entirely.
  if (contract !== undefined && !ethers.isAddress(contract)) {
    throw new Error(
      `'${contract}' is not a valid contract address.\n` +
        "\x1b[2mhint:\x1b[0m expected a 0x-prefixed 20-byte address.",
    );
  }

  // getDeployNetwork() require()s cmu.config.ts, which is arbitrary project
  // code, so gate it the same way `cmu console` does. Only the config file is
  // listed: the explorer runs nothing else from the project.
  // readOnly: the explorer never signs and never unlocks the session, so the
  // PRIVATE_KEY wording `cmu deploy` gets would be untrue here.
  await confirmProjectTrust([findProjectConfig()], {
    yes: options.yes,
    readOnly: true,
  });

  // Read-only by nature - there is no signer here - so the encrypted session
  // is never touched and the password prompt never fires.
  const network = await getDeployNetwork(options.network, { noPrompt: true });

  // Fail here, with the endpoint named, rather than on a raw RPC error.
  await pingNetwork(network.url, network.name);

  const provider = new ethers.JsonRpcProvider(network.url, undefined, {
    staticNetwork: true,
  });

  try {
    if (blockNumber !== undefined) {
      // prefetchTxs is left off: the block then carries transaction hashes,
      // which is all a count needs, instead of every full transaction object.
      const found = await provider.getBlock(blockNumber);
      if (!found) {
        // Only now is a second round trip worth it - naming the tip turns a
        // null into the reason the block is missing.
        const tip = await provider.getBlockNumber();
        throw new Error(
          `block ${blockNumber} does not exist on '${network.name}'.\n` +
            `\x1b[2mhint:\x1b[0m the chain is at block ${tip}.`,
        );
      }
      console.log(formatBlock(found, network.name));
    } else {
      const [code, balance] = await Promise.all([
        provider.getCode(contract as string),
        provider.getBalance(contract as string),
      ]);
      console.log(
        formatContract(contract as string, code, balance, network.name),
      );
    }
  } finally {
    provider.destroy();
  }
}

export const explorerCommand = new Command("explorer")
  .description("Query block and contract information over RPC")
  .option("-b, --block <number>", "Block number to look up")
  .option("-c, --contract <address>", "Contract address to look up")
  .option("-n, --network <name>", "Network to query")
  .option(
    "-y, --yes",
    "Skip the confirmation prompt before executing project code",
  )
  .addHelpText(
    "after",
    "\ncmu.config.ts/js is executed as code from the project directory to resolve\n" +
      "the network. The explorer itself is read-only: it never signs anything and\n" +
      "never asks for your session password. See the 'Trust Model' section of the\n" +
      "README.",
  )
  .action((options: ExplorerOptions, command) => {
    // No blanket hint: the explorer can fail on the flags, the config, the
    // endpoint or the query, and each of those errors carries its own.
    const opts = command.optsWithGlobals() as ExplorerOptions;
    return runExplorer(opts).then(
      () => process.exit(0),
      fail("explorer", opts),
    );
  });
