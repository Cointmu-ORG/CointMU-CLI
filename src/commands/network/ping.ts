import { activeNetwork, getDynamicNetwork } from "../../utils/network";
import { pingNetwork } from "../deploy";

/**
 * Pings a network to check connectivity and latency.
 * @param {string} [name] - The name of the network to ping.
 * @returns {Promise<void>} Resolves when the ping is completed.
 */
export async function runNetworkPing(name?: string): Promise<void> {
  const { name: networkName, rpcUrl } = name
    ? await getDynamicNetwork(name)
    : await activeNetwork(
        "pass a network name, or run `cmu wallet use <name>` first.",
      );

  // Fails within its timeout when the node is down; a bare provider prints
  // ethers' retry notice and a raw error, or hangs on a silent endpoint.
  await pingNetwork(rpcUrl, networkName);
  const { ethers } = await import("ethers");
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
    staticNetwork: true,
  });

  const startTime = Date.now();
  const blockNumber = await provider.getBlockNumber();
  const latency = Date.now() - startTime;

  console.log("--- Ping result ---");
  console.log(`Network      : ${networkName}`);
  console.log(`Block number : ${blockNumber}`);
  console.log(`Latency      : ${latency}ms`);
  console.log("-------------------");
}
