import * as path from "path";
import {
  coinSymbol,
  DEFAULT_SYMBOL,
  isValidSymbol,
  SYMBOL_RULE,
} from "./coinSymbol";
import {
  LOCAL_CHAIN_ID,
  LOCAL_NETWORK_NAME,
  LOCAL_RPC_URL,
  LOCAL_SYMBOL,
} from "./defaults";
import {
  loadNetworks,
  NETWORKS_FILE_LABEL,
  type NetworkEntry,
} from "./networkStorage";
import {
  findProjectConfig,
  JS_CONFIG_FILE,
  loadProjectConfig,
  TS_CONFIG_FILE,
} from "./trust";

/**
 * Where `cmu deploy`, `cmu console` and `cmu explorer` point, before any key
 * is resolved: resolving one can cost a password prompt, so it comes later.
 */
export interface DeployTarget {
  name: string;
  url: string;
  /**
   * From cmu.config. Absent for a network from ~/.cmu-networks.json, which
   * stores none: callers that need it read it from the node.
   */
  chainId?: number;
  symbol: string;
  /** config.wallet.privateKey, when the project config sets one. */
  configKey?: string;
}

const LOCAL_TARGET: DeployTarget = {
  name: LOCAL_NETWORK_NAME,
  url: LOCAL_RPC_URL,
  chainId: LOCAL_CHAIN_ID,
  symbol: LOCAL_SYMBOL,
};

/**
 * How messages name the file a network is read from, the way
 * describeSessionFile() names a session. Only the name: never the contents.
 *
 * @param {string | null} configPath - findProjectConfig()'s result.
 * @returns {string} `./cmu.config.ts`, `./cmu.config.js` or `~/.cmu-networks.json`.
 */
export function describeConfigSource(configPath: string | null): string {
  return configPath ? `./${path.basename(configPath)}` : NETWORKS_FILE_LABEL;
}

/**
 * Resolves the network a command should use.
 *
 * The project's cmu.config overrides as a whole file: when there is one, only
 * it is read, exactly as before global networks existed, and a network it
 * does not define is an error even if ~/.cmu-networks.json saves one by that
 * name. Without one, `-n <name>` is looked up in ~/.cmu-networks.json. With
 * neither `-n` nor a config, this is the local devnet - never the session's
 * active network, so reaching a real network always takes an explicit -n.
 *
 * NOTE: with a config, this require()s it, which runs project code. Callers
 * must have passed it through confirmProjectTrust() first. Without one it
 * reads only JSON, so callers can run it before the trust prompt.
 *
 * @param {string} [targetNetwork] - The -n value.
 * @param {string | null} [configPath] - findProjectConfig()'s result.
 * @returns {Promise<DeployTarget>} The resolved network, without a key.
 * @throws {Error} When the network cannot be resolved or is incomplete.
 */
export async function resolveDeployTarget(
  targetNetwork?: string,
  configPath: string | null = findProjectConfig(),
): Promise<DeployTarget> {
  if (!configPath) return resolveSavedTarget(targetNetwork);

  const config = await loadProjectConfig(configPath);
  // A config exporting nothing was always treated as no config; it keeps its
  // old message rather than reaching the global file.
  if (!config) {
    if (targetNetwork && targetNetwork !== LOCAL_NETWORK_NAME) {
      throw new Error(
        `network '${targetNetwork}' was requested, but no ${TS_CONFIG_FILE} or ${JS_CONFIG_FILE} was found.\n` +
          "\x1b[2mhint:\x1b[0m run this from a CointMU project, or drop -n to deploy to the local network.",
      );
    }
    return LOCAL_TARGET;
  }

  // Named after the file actually loaded: a `cmu create -l javascript`
  // project has no cmu.config.ts to go and edit.
  return resolveProjectTarget(config, path.basename(configPath), targetNetwork);
}

/**
 * The network a cmu.config defines. Moved here unchanged from
 * getDeployNetwork(): every message is the same, word for word.
 *
 * @param {any} config - The loaded config.
 * @param {string} configFile - Its file name, for the messages.
 * @param {string} [targetNetwork] - The -n value.
 * @returns {DeployTarget} The network it defines.
 * @throws {Error} When the network is missing or incomplete.
 */
function resolveProjectTarget(
  config: any,
  configFile: string,
  targetNetwork?: string,
): DeployTarget {
  const networkName =
    targetNetwork || config.defaultNetwork || LOCAL_NETWORK_NAME;
  const network = config.networks?.[networkName];

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
    configKey: config.wallet?.privateKey,
  };
}

/**
 * The network `-n` names in ~/.cmu-networks.json, for a folder without a
 * cmu.config. `-n local` and no -n stay on the built-in devnet, as before.
 *
 * @param {string} [targetNetwork] - The -n value.
 * @returns {Promise<DeployTarget>} The saved network, with no chain ID.
 * @throws {Error} When it is not saved, has no url or has a bad symbol.
 */
async function resolveSavedTarget(
  targetNetwork?: string,
): Promise<DeployTarget> {
  if (!targetNetwork || targetNetwork === LOCAL_NETWORK_NAME) {
    return LOCAL_TARGET;
  }

  const entry = (await readSavedNetworks()).find(
    (n) => n.name === targetNetwork,
  );
  if (!entry) {
    throw new Error(
      `network '${targetNetwork}' is not saved in ${NETWORKS_FILE_LABEL}, and this folder has no ${TS_CONFIG_FILE} or ${JS_CONFIG_FILE}.\n` +
        `\x1b[2mhint:\x1b[0m list saved networks with \`cmu network list\`, save it with \`cmu network save <url> --name ${targetNetwork}\`, or define it in a ${JS_CONFIG_FILE} here.`,
    );
  }
  if (!entry.rpcUrl) {
    throw new Error(
      `network '${targetNetwork}' in ${NETWORKS_FILE_LABEL} has no url.\n` +
        `\x1b[2mhint:\x1b[0m re-save it with \`cmu network save <url> --name ${targetNetwork}\`.`,
    );
  }

  return { name: entry.name, url: entry.rpcUrl, symbol: coinSymbol(entry) };
}

/** What loadSavedNetworks() returns for a networks file that does not parse. */
const UNPARSEABLE_NETWORKS = Symbol("unparseable .cmu-networks.json");

/**
 * loadNetworks(), with a parse failure returned as UNPARSEABLE_NETWORKS, the
 * way parseSession() does it: V8's JSON error quotes the text around the
 * fault, and saved RPC URLs can carry credentials, so it must not reach the
 * output, nor --verbose as the `cause` of another error.
 *
 * @returns {Promise<NetworkEntry[] | typeof UNPARSEABLE_NETWORKS>} The saved
 *   networks, or UNPARSEABLE_NETWORKS.
 */
async function loadSavedNetworks(): Promise<
  NetworkEntry[] | typeof UNPARSEABLE_NETWORKS
> {
  try {
    return await loadNetworks();
  } catch (error) {
    if (error instanceof SyntaxError) return UNPARSEABLE_NETWORKS;
    throw error;
  }
}

/**
 * The saved networks, with a file that does not parse named, never quoted.
 *
 * @returns {Promise<NetworkEntry[]>} The saved networks.
 * @throws {Error} When the file is not valid JSON.
 */
async function readSavedNetworks(): Promise<NetworkEntry[]> {
  const networks = await loadSavedNetworks();
  if (networks === UNPARSEABLE_NETWORKS) {
    throw new Error(
      `could not read ${NETWORKS_FILE_LABEL}: it is not valid JSON.\n` +
        "\x1b[2mhint:\x1b[0m fix it by hand, or remove it to start over with only the local network.",
    );
  }
  return networks;
}
