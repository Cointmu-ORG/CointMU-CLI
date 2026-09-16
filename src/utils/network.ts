import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { loadNetworks } from "./networkStorage";
import { registerTsNode } from "./tsNode";
import { LOCAL_CHAIN_ID, LOCAL_NETWORK_NAME, LOCAL_RPC_URL } from "./defaults";
import { getSessionFilePath, resolvePrivateKey } from "./session";

const TS_CONFIG_FILE = "cmu.config.ts";
const JS_CONFIG_FILE = "cmu.config.js";

export interface NetworkConfig {
  name: string;
  url: string;
  chainId: number;
  privateKey: string | undefined;
}

/**
 * Resolves the dynamic network configuration using .cmu-networks.json
 * and the active CLI session. Used for wallet, mining, and node connections.
 *
 * These callers only need url/chainId/name, so the private key is NOT resolved
 * here: `privateKey` is populated from PRIVATE_KEY when set, but an encrypted
 * .cmu-session is never touched and no password prompt is triggered. Anything
 * that actually needs to sign uses getDeployNetwork().
 *
 * @param {string} [targetNetwork] - An optional override network name.
 * @returns {Promise<NetworkConfig>} The dynamic network configuration.
 */
export async function getDynamicNetwork(
  targetNetwork?: string,
): Promise<NetworkConfig> {
  const sessionFile = getSessionFilePath();

  let activeNetworkName = LOCAL_NETWORK_NAME;

  if (existsSync(sessionFile)) {
    const session = JSON.parse(await readFile(sessionFile, "utf8"));
    if (session.activeNetwork) {
      activeNetworkName = session.activeNetwork;
    }
  }

  const networkName = targetNetwork || activeNetworkName;
  const networks = await loadNetworks();

  const network = networks.find((n) => n.name === networkName);

  if (!network) {
    throw new Error(
      `network '${networkName}' is not saved.\n` +
        "\x1b[2mhint:\x1b[0m list saved networks with `cmu network list`, or add one with `cmu network save <url> --name <name>`.",
    );
  }

  const { ethers } = await import("ethers");
  let chainId = 0;

  try {
    const provider = new ethers.JsonRpcProvider(network.rpcUrl);
    const net = await provider.getNetwork();
    chainId = Number(net.chainId);
  } catch {
    chainId = networkName === LOCAL_NETWORK_NAME ? LOCAL_CHAIN_ID : 0;
  }

  return {
    name: networkName,
    url: network.rpcUrl,
    chainId,
    privateKey: process.env.PRIVATE_KEY,
  };
}

/**
 * Resolves the static network configuration directly from the project's cmu.config.ts/js.
 * Used exclusively for deterministic smart contract deployments.
 *
 * NOTE: require()ing cmu.config.ts runs project code. The confirmation gate for
 * that lives in the callers (runDeploy, runCompile) via confirmProjectTrust(),
 * which must run before this function and is memoised per process so the user
 * is asked once. Any new caller of this function must gate it the same way.
 *
 * @param {string} [targetNetwork] - The explicitly requested deployment network name.
 * @returns {Promise<NetworkConfig>} The static deployment network configuration.
 */
export async function getDeployNetwork(
  targetNetwork?: string,
  options: { noPrompt?: boolean } = {},
): Promise<NetworkConfig> {
  const path = await import("path");

  let config: any = null;
  const tsConfigPath = path.resolve(process.cwd(), TS_CONFIG_FILE);
  const jsConfigPath = path.resolve(process.cwd(), JS_CONFIG_FILE);

  if (existsSync(tsConfigPath)) {
    await registerTsNode();
    const mod = require(tsConfigPath);
    config = mod.default || mod;
  } else if (existsSync(jsConfigPath)) {
    config = require(jsConfigPath);
  }

  if (!config) {
    if (targetNetwork && targetNetwork !== LOCAL_NETWORK_NAME) {
      throw new Error(
        `network '${targetNetwork}' was requested, but no cmu.config.ts was found.\n` +
          "\x1b[2mhint:\x1b[0m run this from a CointMU project, or drop -n to deploy to the local network.",
      );
    }
    return {
      name: LOCAL_NETWORK_NAME,
      url: LOCAL_RPC_URL,
      chainId: LOCAL_CHAIN_ID,
      privateKey: await resolvePrivateKey({ prompt: !options.noPrompt }),
    };
  }

  const networkName =
    targetNetwork || config.defaultNetwork || LOCAL_NETWORK_NAME;
  const network = config.networks?.[networkName];

  if (!network) {
    throw new Error(
      `network '${networkName}' is not defined in ${TS_CONFIG_FILE}.\n` +
        "\x1b[2mhint:\x1b[0m add it under `networks`, or pick one that is already defined.",
    );
  }

  return {
    name: networkName,
    url: network.url,
    chainId: network.chainId,
    privateKey:
      config.wallet?.privateKey ||
      (await resolvePrivateKey({ prompt: !options.noPrompt })),
  };
}
