/**
 * The local CointMU devnet, in one place. These four values travel together -
 * the RPC endpoint is the port, the scaffolded config quotes both, and the
 * devnet, the saved-network seed and the deploy fallback all have to agree on
 * the chain - so a copy that drifts points a command at a network that is not
 * there.
 */

/** Name the local network is saved and referred to under. */
export const LOCAL_NETWORK_NAME = "local";

/** Chain ID of the CointMU devnet. */
export const LOCAL_CHAIN_ID = 1912;

/** Port `cmu node start` binds by default. */
export const LOCAL_PORT = 8585;

/** RPC endpoint of the local devnet. Derived, so it cannot disagree with the port. */
export const LOCAL_RPC_URL = `http://127.0.0.1:${LOCAL_PORT}`;
