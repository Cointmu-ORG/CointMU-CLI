import * as path from "path";
import { loadNetworks, type NetworkEntry } from "./networkStorage";
import { DEFAULT_SYMBOL, isValidSymbol, SYMBOL_RULE } from "./coinSymbol";
import {
  LOCAL_CHAIN_ID,
  LOCAL_NETWORK_NAME,
  LOCAL_RPC_URL,
  LOCAL_SYMBOL,
} from "./defaults";
import { readSession, requireSession, resolvePrivateKey } from "./session";
import {
  findProjectConfig,
  JS_CONFIG_FILE,
  loadProjectConfig,
  TS_CONFIG_FILE,
} from "./trust";

export interface NetworkConfig {
  name: string;
  url: string;
  chainId: number;
  /** Coin symbol amounts are labelled with: networks.<name>.symbol, else ETH. */
  symbol: string;
  privateKey: string | undefined;
}

/**
 * Name of the network the session has selected, falling back to the local
 * devnet. Never throws: callers that only need something to point at (and to
 * mark in a listing) treat "no session yet" as "local".
 *
 * @returns {Promise<string>} The active network name.
 */
export async function activeNetworkName(): Promise<string> {
  const session = await readSession();
  return session?.activeNetwork || LOCAL_NETWORK_NAME;
}

/**
 * The saved network entry the session has selected.
 *
 * The counterpart to activeNetworkName() for callers that cannot do anything
 * useful without a real network, so each way of not having one - no session, a
 * session that never picked a network, a pick that has since been deleted - is
 * a distinct error with its own hint.
 *
 * @param {string} [noSessionHint] - Hint for the "no session" case, which is
 *   the one where the advice depends on the command.
 * @returns {Promise<NetworkEntry>} The active network.
 * @throws {Error} When there is no usable active network.
 */
export async function activeNetwork(
  noSessionHint = "run `cmu wallet use <wallet>`, then `cmu network use <network>`.",
): Promise<NetworkEntry> {
  const session = await requireSession(noSessionHint);

  if (!session.activeNetwork) {
    throw new Error(
      "no active network in the session.\n" +
        "\x1b[2mhint:\x1b[0m select one with `cmu network use <name>`.",
    );
  }

  const entry = (await loadNetworks()).find(
    (n) => n.name === session.activeNetwork,
  );
  if (!entry) {
    throw new Error(
      `active network '${session.activeNetwork}' is no longer saved.\n` +
        "\x1b[2mhint:\x1b[0m pick an existing one with `cmu network use <name>`, or re-add it with `cmu network save <url> --name <name>`.",
    );
  }

  return entry;
}

/**
 * The saved network a read-only command should talk to: the one named, or the
 * one the session selected, falling back to the local devnet.
 *
 * Unlike getDeployNetwork() this resolves no private key and opens no
 * connection - callers here only need somewhere to point a provider at, so the
 * encrypted .cmu-session is never touched and no password prompt is triggered.
 * Anything that actually needs to sign uses getDeployNetwork().
 *
 * @param {string} [targetNetwork] - An optional override network name.
 * @returns {Promise<NetworkEntry>} The resolved network entry.
 * @throws {Error} When the named network is not saved.
 */
export async function getDynamicNetwork(
  targetNetwork?: string,
): Promise<NetworkEntry> {
  const networkName = targetNetwork || (await activeNetworkName());
  const network = (await loadNetworks()).find((n) => n.name === networkName);

  if (!network) {
    throw new Error(
      `network '${networkName}' is not saved.\n` +
        "\x1b[2mhint:\x1b[0m list saved networks with `cmu network list`, or add one with `cmu network save <url> --name <name>`.",
    );
  }

  return network;
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
  const configPath = findProjectConfig();
  const config = configPath ? await loadProjectConfig(configPath) : null;

  if (!configPath || !config) {
    if (targetNetwork && targetNetwork !== LOCAL_NETWORK_NAME) {
      throw new Error(
        `network '${targetNetwork}' was requested, but no ${TS_CONFIG_FILE} or ${JS_CONFIG_FILE} was found.\n` +
          "\x1b[2mhint:\x1b[0m run this from a CointMU project, or drop -n to deploy to the local network.",
      );
    }
    return {
      name: LOCAL_NETWORK_NAME,
      url: LOCAL_RPC_URL,
      chainId: LOCAL_CHAIN_ID,
      symbol: LOCAL_SYMBOL,
      privateKey: await resolvePrivateKey({ prompt: !options.noPrompt }),
    };
  }

  const networkName =
    targetNetwork || config.defaultNetwork || LOCAL_NETWORK_NAME;
  const network = config.networks?.[networkName];
  // Named after the file actually loaded: a `cmu create -l javascript`
  // project has no cmu.config.ts to go and edit.
  const configFile = path.basename(configPath);

  if (!network) {
    throw new Error(
      `network '${networkName}' is not defined in ${configFile}.\n` +
        "\x1b[2mhint:\x1b[0m add it under `networks`, or pick one that is already defined.",
    );
  }

  // Checked here rather than left to pingNetwork(), which knows neither the
  // network's name nor which config it came from. Before the key is resolved,
  // so a config error never costs the user a password prompt first. The stock
  // `cmu create` scaffold ships `mainnet` with url: "".
  if (!network.url) {
    throw new Error(
      `network '${networkName}' has no url.\n` +
        `\x1b[2mhint:\x1b[0m set networks.${networkName}.url in ${configFile}.`,
    );
  }
  // Optional; checked with the url for the same reason.
  if (network.symbol !== undefined && !isValidSymbol(network.symbol)) {
    throw new Error(
      `network '${networkName}' has an invalid symbol ${JSON.stringify(network.symbol)} - ${SYMBOL_RULE}.\n` +
        `\x1b[2mhint:\x1b[0m fix networks.${networkName}.symbol in ${configFile}, or remove it to use ${DEFAULT_SYMBOL}.`,
    );
  }

  return {
    name: networkName,
    url: network.url,
    chainId: network.chainId,
    symbol: network.symbol ?? DEFAULT_SYMBOL,
    privateKey:
      config.wallet?.privateKey ||
      (await resolvePrivateKey({ prompt: !options.noPrompt })),
  };
}
