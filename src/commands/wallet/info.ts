import { coinSymbol } from "../../utils/coinSymbol";
import { getDynamicNetwork } from "../../utils/network";
import { requireSession } from "../../utils/session";

/**
 * Fetch and display the native token balance of the logged-in wallet.
 * @returns {Promise<void>}
 */
export async function runWalletBalance(): Promise<void> {
  const session = await requireSession();

  const { ethers } = await import("ethers");

  const network = await getDynamicNetwork(session.activeNetwork);
  const symbol = coinSymbol(network);
  const provider = new ethers.JsonRpcProvider(network.rpcUrl);

  console.log(`Connecting to ${network.name} (${network.rpcUrl})...`);
  const balance = await provider.getBalance(session.address);

  console.log("---------------------------");
  console.log(`Address : ${session.address}`);
  console.log(`Balance : ${ethers.formatEther(balance)} ${symbol}`);
  console.log("---------------------------");
}

/**
 * Display the current active wallet session information.
 * @returns {Promise<void>}
 */
export async function runWalletInfo(): Promise<void> {
  const session = await requireSession();

  const network = await getDynamicNetwork(session.activeNetwork);

  console.log("--- Active session ---");
  console.log(`Address      : ${session.address}`);
  console.log(`Network      : ${network.name}`);
  console.log(`RPC endpoint : ${network.rpcUrl}`);
  console.log("----------------------");
}
