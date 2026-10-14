import { Command } from "commander";
import type { JsonRpcProvider } from "ethers";
import { fail } from "../../utils/errors";
import { getDynamicNetwork } from "../../utils/network";
import { requireSession } from "../../utils/session";
import {
  HINT,
  WARNING,
  optional,
  sameAddress,
  formatHashrate,
  formatAge,
  readStatus,
  sendMiner,
} from "./status";
import { watchMining } from "./watch";

export {
  formatAge,
  formatHashrate,
  isUnsupported,
  optional,
  readStatus,
} from "./status";
export type { MiningStatus } from "./status";
export { backoff, watchMining } from "./watch";

/**
 * Warns before `mine start` takes over an etherbase someone else is mining
 * to. It still goes ahead: the etherbase is node-wide by design, and the point
 * is that the takeover is no longer silent.
 */
async function warnIfForeignEtherbase(
  provider: JsonRpcProvider,
  address: string,
): Promise<void> {
  const [mining, coinbase] = await Promise.all([
    optional<boolean>(provider.send("eth_mining", [])),
    optional<string>(provider.send("eth_coinbase", [])),
  ]);
  if (mining && coinbase && !sameAddress(coinbase, address)) {
    console.log(`${WARNING} this node is already mining to ${coinbase}.`);
    console.log(
      `${HINT} starting moves its rewards to ${address}. The etherbase is node-wide, and \`cmu mine stop\` stops mining for everyone.`,
    );
  }
}

/**
 * Starts or stops mining on the active network. Starting points the etherbase
 * at the logged-in wallet first, so the rewards go to it.
 *
 * @param {"miner_start" | "miner_stop"} method - The miner RPC call to make.
 * @param {unknown[]} params - Its parameters.
 * @param {object} [options]
 * @param {boolean} [options.watch] - Keep watching after starting.
 * @returns {Promise<void>} Resolves once the node has accepted the call.
 */
async function runMiner(
  method: "miner_start" | "miner_stop",
  params: unknown[],
  options: { watch?: boolean } = {},
): Promise<void> {
  const session = await requireSession();

  const { ethers } = await import("ethers");

  const network = await getDynamicNetwork(session.activeNetwork);
  const provider = new ethers.JsonRpcProvider(network.rpcUrl, undefined, {
    staticNetwork: true,
  });
  const starting = method === "miner_start";

  if (starting) {
    await warnIfForeignEtherbase(provider, session.address);
    console.log(`Setting etherbase to ${session.address}...`);
    await sendMiner(provider, network.name, "miner_setEtherbase", [
      session.address,
    ]);
  }

  console.log(
    `${starting ? "Starting" : "Stopping"} miner on ${network.name}...`,
  );
  await sendMiner(provider, network.name, method, params);

  if (!starting) {
    console.log("Mining stopped.");
    return;
  }
  console.log("Mining started.");
  console.log(`Rewards are routed to ${session.address}`);
  if (!options.watch) return;

  console.log(
    "\nWatching. Ctrl-C leaves the watch - mining keeps running until `cmu mine stop`.\n" +
      "The first block can take minutes while ethash builds its DAG.\n" +
      "Balance change counts block rewards, uncle rewards and fees, plus any transfer in or out.\n",
  );
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  await watchMining(provider, session.address, controller.signal);
  console.log(
    `Stopped watching. Mining is still running on ${network.name} - stop it with \`cmu mine stop\`.`,
  );
  // An RPC request still in flight would otherwise hold the process open.
  process.exit(0);
}

/**
 * One-shot, read-only view of the node's mining state. Uses only the
 * plaintext address in .cmu-session, so it never asks for a password.
 *
 * @returns {Promise<void>}
 */
async function runMineStatus(): Promise<void> {
  const session = await requireSession();

  const { ethers } = await import("ethers");

  const network = await getDynamicNetwork(session.activeNetwork);
  const provider = new ethers.JsonRpcProvider(network.rpcUrl, undefined, {
    staticNetwork: true,
  });

  const status = await readStatus(provider, session.address);
  const { block, coinbase, mining } = status;
  const foreign = coinbase !== null && !sameAddress(coinbase, session.address);
  const age = Date.now() / 1000 - block.timestamp;

  console.log("--- Mining status ---");
  console.log(`Network      : ${network.name} (${network.rpcUrl})`);
  console.log(
    `Mining       : ${mining === null ? "n/a" : mining ? "yes" : "no"}`,
  );
  console.log(`Hashrate     : ${formatHashrate(status.hashrate)}`);
  console.log(
    `Etherbase    : ${coinbase ?? "n/a"}${foreign ? " (not your session wallet - rewards go there)" : ""}`,
  );
  console.log(`Latest block : #${block.number}, ${formatAge(age)} ago`);
  console.log(`Difficulty   : ${block.difficulty}`);
  console.log(`Wallet       : ${session.address}`);
  console.log(`Balance      : ${ethers.formatEther(status.balance)} ETH`);
  console.log("---------------------");
}

export const mineCommand = new Command("mine").description(
  "Control mining on the active network",
);

mineCommand
  .command("start")
  .description("Start mining with the active wallet")
  .option(
    "--watch",
    "Keep watching mining progress (Ctrl-C leaves; mining keeps running)",
  )
  .action((options, command) =>
    // One mining thread.
    runMiner("miner_start", [1], options).catch(
      fail("mine start", command.optsWithGlobals()),
    ),
  );

mineCommand
  .command("stop")
  .description("Stop mining")
  .action((options, command) =>
    runMiner("miner_stop", []).catch(
      fail("mine stop", command.optsWithGlobals()),
    ),
  );

mineCommand
  .command("status")
  .description("Show mining state, hashrate, etherbase and your balance")
  .action((options, command) =>
    runMineStatus().catch(fail("mine status", command.optsWithGlobals())),
  );
