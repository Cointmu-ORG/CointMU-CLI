import { Command } from "commander";
import { fail } from "../utils/errors";
import { getDynamicNetwork } from "../utils/network";
import { requireSession } from "../utils/session";

/**
 * Starts or stops mining on the active network. Starting points the etherbase
 * at the logged-in wallet first, so the rewards go to it.
 *
 * @param {"miner_start" | "miner_stop"} method - The miner RPC call to make.
 * @param {unknown[]} params - Its parameters.
 * @returns {Promise<void>} Resolves once the node has accepted the call.
 */
async function runMiner(
  method: "miner_start" | "miner_stop",
  params: unknown[],
): Promise<void> {
  const session = await requireSession();

  const { ethers } = await import("ethers");

  const network = await getDynamicNetwork(session.activeNetwork);
  const provider = new ethers.JsonRpcProvider(network.rpcUrl);
  const starting = method === "miner_start";

  if (starting) {
    console.log(`Setting etherbase to ${session.address}...`);
    await provider.send("miner_setEtherbase", [session.address]);
  }

  console.log(
    `${starting ? "Starting" : "Stopping"} miner on ${network.name}...`,
  );
  await provider.send(method, params);

  if (starting) {
    console.log("Mining started.");
    console.log(`Rewards are routed to ${session.address}`);
  } else {
    console.log("Mining stopped.");
  }
}

export const mineCommand = new Command("mine").description(
  "Control mining on the active network",
);

mineCommand
  .command("start")
  .description("Start mining with the logged-in wallet")
  .action((options, command) =>
    // One mining thread.
    runMiner("miner_start", [1]).catch(
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
