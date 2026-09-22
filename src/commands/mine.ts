import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { Command } from "commander";
import { fail } from "../utils/errors";
import { getSessionFilePath } from "../utils/session";

const MINER_THREAD_COUNT = 1;

/**
 * Starts the mining process on the active network.
 * @returns {Promise<void>} Resolves when mining is started successfully.
 */
async function runMineStart(): Promise<void> {
  const sessionFile = getSessionFilePath();

  if (!existsSync(sessionFile)) {
    throw new Error(
      "no active session.\n" +
        "\x1b[2mhint:\x1b[0m run `cmu wallet login` first.",
    );
  }

  const session = JSON.parse(await readFile(sessionFile, "utf8"));
  const { getDynamicNetwork } = await import("../utils/network");
  const { ethers } = await import("ethers");

  const network = await getDynamicNetwork(session.activeNetwork);
  const provider = new ethers.JsonRpcProvider(network.rpcUrl);

  console.log(`Setting etherbase to ${session.address}...`);
  await provider.send("miner_setEtherbase", [session.address]);

  console.log(`Starting miner on ${network.name}...`);
  await provider.send("miner_start", [MINER_THREAD_COUNT]);

  console.log("Mining started.");
  console.log(`Rewards are routed to ${session.address}`);
}

/**
 * Stops the mining process on the active network.
 * @returns {Promise<void>} Resolves when mining is stopped successfully.
 */
async function runMineStop(): Promise<void> {
  const sessionFile = getSessionFilePath();

  if (!existsSync(sessionFile)) {
    throw new Error(
      "no active session.\n" +
        "\x1b[2mhint:\x1b[0m run `cmu wallet login` first.",
    );
  }

  const session = JSON.parse(await readFile(sessionFile, "utf8"));
  const { getDynamicNetwork } = await import("../utils/network");
  const { ethers } = await import("ethers");

  const network = await getDynamicNetwork(session.activeNetwork);
  const provider = new ethers.JsonRpcProvider(network.rpcUrl);

  console.log(`Stopping miner on ${network.name}...`);
  await provider.send("miner_stop", []);

  console.log("Mining stopped.");
}

export const mineCommand = new Command("mine").description(
  "Control mining on the active network",
);

mineCommand
  .command("start")
  .description("Start mining with the logged-in wallet")
  .action((options, command) =>
    runMineStart().catch(fail("mine start", command.optsWithGlobals())),
  );

mineCommand
  .command("stop")
  .description("Stop mining")
  .action((options, command) =>
    runMineStop().catch(fail("mine stop", command.optsWithGlobals())),
  );
