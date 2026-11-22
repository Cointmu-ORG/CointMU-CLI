import { resolveDeployTarget, type DeployTarget } from "./deployTarget";
import { loadNetworks, type NetworkEntry } from "./networkStorage";
import { LOCAL_NETWORK_NAME } from "./defaults";
import { readSession, requireSession, resolvePrivateKey } from "./session";

export interface NetworkConfig {
  name: string;
  url: string;
  /** Absent for a network from ~/.cmu-networks.json; read it from the node. */
  chainId?: number;
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
 * Adds the signing key to a resolved target: config.wallet.privateKey, else
 * PRIVATE_KEY, else the session (which may prompt for its password).
 *
 * @param {DeployTarget} target - From resolveDeployTarget().
 * @param {object} [options]
 * @param {boolean} [options.noPrompt] - Never prompt for the session password.
 * @returns {Promise<NetworkConfig>} The target with its key.
 */
export async function withDeployKey(
  target: DeployTarget,
  options: { noPrompt?: boolean } = {},
): Promise<NetworkConfig> {
  const { configKey, ...network } = target;
  return {
    ...network,
    privateKey:
      configKey || (await resolvePrivateKey({ prompt: !options.noPrompt })),
  };
}

/**
 * Resolves the network and its key in one step: the project's cmu.config when
 * there is one, else ~/.cmu-networks.json for `-n`, else the local devnet.
 * See resolveDeployTarget() for the rules.
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
  return withDeployKey(await resolveDeployTarget(targetNetwork), options);
}
