import { LOCAL_NETWORK_NAME } from "../../utils/defaults";
import { loadNetworks } from "../../utils/networkStorage";
import { loadWallets } from "../../utils/walletStorage";
import {
  type EncryptedKey,
  getSessionFilePath,
  readSession,
  type SessionData,
  writeSessionFile,
} from "../../utils/session";
import { requireInteractive } from "./prompts";
import { sameAddress } from "./savedWallets";

/**
 * The activeNetwork a new session should carry: the one the existing session
 * selected, as long as it is still saved. Falls back to the local devnet for a
 * first session, an unreadable session file, or a pick that has since been
 * deleted - and says so in that last case, since the user did choose it.
 *
 * @returns {Promise<string>} The network name the new session should record.
 */
async function carriedOverNetwork(): Promise<string> {
  let previous: string | undefined;
  try {
    previous = (await readSession())?.activeNetwork;
  } catch {
    // A corrupt session file must not block `use` - it is the way out of it.
    return LOCAL_NETWORK_NAME;
  }
  if (!previous) return LOCAL_NETWORK_NAME;

  if ((await loadNetworks()).some((n) => n.name === previous)) return previous;

  console.log(
    `\x1b[33mwarning:\x1b[0m network '${previous}' is no longer saved - ` +
      `active network reset to ${LOCAL_NETWORK_NAME}.`,
  );
  return LOCAL_NETWORK_NAME;
}

/**
 * Stops before a session write that would throw away a key cmu has no other
 * copy of: the session holds a key it can open, and its address is not a
 * saved wallet. Asks, defaulting to no. Replacing a session with the wallet
 * it already holds needs no case of its own: that wallet is saved.
 *
 * Runs before any prompt for a key or password, so nobody types a secret
 * only to be told no. An unreadable session passes: nothing can be read from
 * it to name, and writing a session is the way out of one. An unreadable
 * store throws: whether the key is safe cannot be told.
 *
 * @returns {Promise<void>} Resolves when the session may be replaced.
 * @throws {Error} When the user declines, or cannot be asked.
 */
async function confirmSessionReplace(): Promise<void> {
  let session: SessionData | null;
  try {
    session = await readSession();
  } catch {
    // Unreadable: no address to name, and replacing it is the way out of it.
    return;
  }
  if (!session || !sessionHoldsOpenableKey(session)) return;
  const previous = session.address;
  if ((await loadWallets()).some((w) => sameAddress(w.address, previous))) {
    return;
  }

  console.log(
    `\x1b[33mwarning:\x1b[0m .cmu-session holds the key for ${previous}, which is not a saved wallet.`,
  );
  console.log(
    "Replacing the session deletes that key for good - cmu keeps no other copy and cannot recover it.",
  );
  console.log(
    "\x1b[2mhint:\x1b[0m keep it first with `cmu wallet save <name> --session`, then run this command again.",
  );
  requireInteractive(
    "confirmation",
    "keep the key first with `cmu wallet save <name> --session`, or run this in a terminal to confirm.",
  );
  const inquirer = (await import("inquirer")).default;
  const { replace } = await inquirer.prompt([
    {
      type: "confirm",
      name: "replace",
      message: "Replace it anyway?",
      default: false,
    },
  ]);
  if (!replace) {
    throw new Error(
      `aborted: .cmu-session was not changed; it still holds ${previous}.`,
    );
  }
}

/**
 * Writes an encrypted key to .cmu-session, carrying the active network over.
 *
 * The one writer of a key into the session, so `use` keeps the network #126
 * was about, and passes the #182 check. The check runs first; `unlock` -
 * where every prompt for a key or password lives - only after it, so no
 * caller can ask for a secret before the user agreed to lose the old key.
 *
 * @param {() => Promise<{address: string, encrypted: EncryptedKey}>} unlock -
 *   Prompts for whatever is needed and returns the key to store.
 * @returns {Promise<{address: string, activeNetwork: string}>} The address the
 *   session belongs to, and the network it ended up pointing at.
 */
export async function storeSession(
  unlock: () => Promise<{ address: string; encrypted: EncryptedKey }>,
): Promise<{ address: string; activeNetwork: string }> {
  await confirmSessionReplace();
  const { address, encrypted } = await unlock();
  const activeNetwork = await carriedOverNetwork();
  await writeSessionFile(getSessionFilePath(), {
    address,
    activeNetwork,
    ...encrypted,
  });
  return { address, activeNetwork };
}

/**
 * The address this project's .cmu-session belongs to. Needs no password: the
 * address is stored in plaintext. An unreadable session counts as none, so it
 * cannot stop `list` or `use` - `use` is a way out of it.
 *
 * @returns {Promise<string | undefined>} The address, if there is a session.
 */
export async function sessionAddress(): Promise<string | undefined> {
  try {
    return (await readSession())?.address;
  } catch {
    return undefined;
  }
}

/**
 * Whether a session holds a key this cmu can open: every AES-GCM field is
 * there. A session without one - network only, or from before GCM - has no
 * key to save here, and none to lose.
 *
 * @param {SessionData} session - The parsed .cmu-session.
 * @returns {boolean} True when the session carries a complete encrypted key.
 */
export function sessionHoldsOpenableKey(
  session: SessionData,
): session is SessionData & Omit<EncryptedKey, "iterations"> {
  return !!(
    session.encryptedKey &&
    session.salt &&
    session.iv &&
    session.authTag
  );
}
