import { loadNetworks } from "./networkStorage";
import { resolvePrivateKey } from "./session";

const SESSION_FILE_NAME = ".cmu-session";
const DEFAULT_NETWORK = "local";
const LOCAL_CHAIN_ID = 1912;
const LOCAL_URL = "http://127.0.0.1:8585";
const TS_CONFIG_FILE = "cmu.config.ts";
const JS_CONFIG_FILE = "cmu.config.js";
const MODULE_FORMAT = "CommonJS";

const FS_EXTRA_PKG = "fs-extra";
const PATH_PKG = "path";
const ETHERS_PKG = "ethers";
const TS_NODE_PKG = "ts-node";
const TS_COMPILER = "typescript";

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
  const fs =
    (await import(FS_EXTRA_PKG)).default || (await import(FS_EXTRA_PKG));
  const path = await import(PATH_PKG);
  const sessionFile = path.resolve(process.cwd(), SESSION_FILE_NAME);

  let activeNetworkName = DEFAULT_NETWORK;

  if (await fs.pathExists(sessionFile)) {
    const session = await fs.readJson(sessionFile);
    if (session.activeNetwork) {
      activeNetworkName = session.activeNetwork;
    }
  }

  const networkName = targetNetwork || activeNetworkName;
  const networks = await loadNetworks();

  const network = networks.find((n) => n.name === networkName);

  if (!network) {
    throw new Error(
      `Network configuration for '${networkName}' not found in saved networks.`,
    );
  }

  const { ethers } = await import(ETHERS_PKG);
  let chainId = 0;

  try {
    const provider = new ethers.JsonRpcProvider(network.rpcUrl);
    const net = await provider.getNetwork();
    chainId = Number(net.chainId);
  } catch {
    chainId = networkName === DEFAULT_NETWORK ? LOCAL_CHAIN_ID : 0;
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
  const fs =
    (await import(FS_EXTRA_PKG)).default || (await import(FS_EXTRA_PKG));
  const path = await import(PATH_PKG);

  let config: any = null;
  const tsConfigPath = path.resolve(process.cwd(), TS_CONFIG_FILE);
  const jsConfigPath = path.resolve(process.cwd(), JS_CONFIG_FILE);

  if (await fs.pathExists(tsConfigPath)) {
    const tsNode = await import(TS_NODE_PKG);
    tsNode.register({
      transpileOnly: true,
      compiler: TS_COMPILER,
      compilerOptions: { module: MODULE_FORMAT },
    });
    const mod = require(tsConfigPath);
    config = mod.default || mod;
  } else if (await fs.pathExists(jsConfigPath)) {
    config = require(jsConfigPath);
  }

  if (!config) {
    if (targetNetwork && targetNetwork !== DEFAULT_NETWORK) {
      throw new Error(
        `Configuration file not found, but a specific network '${targetNetwork}' was requested for deployment.`,
      );
    }
    return {
      name: DEFAULT_NETWORK,
      url: LOCAL_URL,
      chainId: LOCAL_CHAIN_ID,
      privateKey: await resolvePrivateKey({ prompt: !options.noPrompt }),
    };
  }

  const networkName = targetNetwork || config.defaultNetwork || DEFAULT_NETWORK;
  const network = config.networks?.[networkName];

  if (!network) {
    throw new Error(
      `Static deployment network configuration for '${networkName}' not found in ${TS_CONFIG_FILE}.`,
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
