import * as path from "path";
import { readFile, writeFile } from "fs/promises";
import { LOCAL_NETWORK_NAME, LOCAL_RPC_URL } from "../../utils/defaults";
import { loadNetworks } from "../../utils/networkStorage";
import { loadWallets } from "../../utils/walletStorage";
import {
  type EncryptedKey,
  getSessionFilePath,
  readSession,
  SESSION_FILE_MODE,
  type SessionData,
  writeSessionFile,
} from "../../utils/session";
import { requireInteractive } from "./prompts";
import { sameAddress } from "./savedWallets";

/** Appended to .cmu-session, then a timestamp, to name a backup (#209). */
const BACKUP_SUFFIX = ".bak-";

/**
 * The activeNetwork a new session should carry: the one the existing session
 * selected, as long as it is still saved. Falls back to the local devnet for a
 * first session, an unreadable session file, or a pick that has since been
 * deleted - and says so in that last case, since the user did choose it. A
 * local network that is no longer saved is warned about on every fallback,
 * with the command that re-adds it.
 *
 * @returns {Promise<string>} The network name the new session should record.
 */
async function carriedOverNetwork(): Promise<string> {
  let previous: string | undefined;
  try {
    previous = (await readSession())?.activeNetwork;
  } catch {
    // A corrupt session file must not block `use` - it is the way out of it.
    previous = undefined;
  }
  const saved = (await loadNetworks()).map((n) => n.name);
  if (previous && saved.includes(previous)) return previous;

  if (!saved.includes(LOCAL_NETWORK_NAME)) {
    console.log(
      `\x1b[33mwarning:\x1b[0m network '${LOCAL_NETWORK_NAME}' is not saved - ` +
        `re-add it with \`cmu network save ${LOCAL_RPC_URL} --name ${LOCAL_NETWORK_NAME}\`.`,
    );
  } else if (previous) {
    console.log(
      `\x1b[33mwarning:\x1b[0m network '${previous}' is no longer saved - ` +
        `active network reset to ${LOCAL_NETWORK_NAME}.`,
    );
  }
  return LOCAL_NETWORK_NAME;
}

/**
 * A key the session file may hold, as far as cmu can tell without a password:
 * one it can open, one it cannot (cmu 1.3.1 and older wrote AES-CBC, with no
 * authTag), or a file that does not parse at all.
 */
interface KeyAtRisk {
  kind: "openable" | "unopenable" | "unreadable";
  /** The address the file names, when it can be read. */
  address?: string;
}

/** What parseSession() returns for a session file that does not parse. */
export const UNPARSEABLE_SESSION = Symbol("unparseable .cmu-session");

/**
 * readSession(), with a file that does not parse returned as
 * UNPARSEABLE_SESSION instead of thrown. V8's JSON error quotes the text
 * around the fault, ciphertext included, so it must not reach the output,
 * nor --verbose as the `cause` of another error.
 *
 * @returns {Promise<SessionData | null | typeof UNPARSEABLE_SESSION>} The
 *   session, null if there is none, or UNPARSEABLE_SESSION.
 * @throws {Error} When the file exists but cannot be read at all.
 */
export async function parseSession(): Promise<
  SessionData | null | typeof UNPARSEABLE_SESSION
> {
  try {
    return await readSession();
  } catch (error) {
    if (error instanceof SyntaxError) return UNPARSEABLE_SESSION;
    throw error;
  }
}

/**
 * What replacing .cmu-session could lose. Undefined only when the file
 * provably holds no key: absent, blank, or valid JSON without an encryptedKey.
 *
 * @returns {Promise<KeyAtRisk | undefined>} The key at risk, if any.
 * @throws {Error} When the file exists but cannot be read at all.
 */
async function keyAtRisk(): Promise<KeyAtRisk | undefined> {
  const session = await parseSession();
  if (session === UNPARSEABLE_SESSION) {
    const text = await readFile(getSessionFilePath(), "utf8");
    return text.trim() ? { kind: "unreadable" } : undefined;
  }
  if (!session?.encryptedKey) return undefined;
  const address =
    typeof session.address === "string" ? session.address : undefined;
  const kind = sessionHoldsOpenableKey(session) ? "openable" : "unopenable";
  return { kind, address };
}

/** The line that says a copy will be kept, for a key `save` cannot keep. */
const KEEPS_COPY = `If you replace it, cmu keeps a copy as .cmu-session${BACKUP_SUFFIX}<time> first.`;

/**
 * What to tell the user about a key at risk: the warning lines, and the way
 * out when there is no terminal to ask in.
 *
 * @param {KeyAtRisk} risk - The key the session may hold.
 * @returns {{lines: string[], noTerminal: string}} The text to print.
 */
function describeRisk(risk: KeyAtRisk): {
  lines: string[];
  noTerminal: string;
} {
  if (risk.kind === "openable") {
    return {
      lines: [
        `\x1b[33mwarning:\x1b[0m .cmu-session holds the key for ${risk.address}, which is not a saved wallet.`,
        "Replacing the session deletes that key for good - cmu keeps no other copy and cannot recover it.",
        "\x1b[2mhint:\x1b[0m keep it first with `cmu wallet save <name> --session`, then run this command again.",
      ],
      noTerminal:
        "keep the key first with `cmu wallet save <name> --session`, or run this in a terminal to confirm.",
    };
  }
  const warning =
    risk.kind === "unopenable"
      ? `.cmu-session holds an encrypted key for ${risk.address ?? "an unreadable address"} that this version of cmu cannot open (written by cmu 1.3.1 or older, or incomplete).`
      : ".cmu-session is not valid JSON, so cmu cannot tell whether it holds a key.";
  const fix = risk.kind === "unopenable" ? "" : "fix it, or ";
  return {
    lines: [
      `\x1b[33mwarning:\x1b[0m ${warning}`,
      KEEPS_COPY,
      `\x1b[2mhint:\x1b[0m to keep it out of the way instead, ${fix}move .cmu-session somewhere safe, then run this command again.`,
    ],
    noTerminal: `${fix}move .cmu-session somewhere safe first, or run this in a terminal to confirm.`,
  };
}

/**
 * Stops before a session write that would throw away a key cmu has no other
 * copy of: the session may hold a key whose address is not a saved wallet.
 * Asks, defaulting to no. Replacing a session with the wallet it already
 * holds needs no case of its own: that wallet is saved.
 *
 * Runs before any prompt for a key or password, so nobody types a secret
 * only to be told no. A file cmu cannot open or parse counts as a key too
 * (#209): it may well hold one. An unreadable store throws: whether the key
 * is safe cannot be told.
 *
 * @returns {Promise<boolean>} True when the file must be backed up before it
 *   is replaced: it holds a key `wallet save --session` cannot keep.
 * @throws {Error} When the user declines, or cannot be asked.
 */
async function confirmSessionReplace(): Promise<boolean> {
  const risk = await keyAtRisk();
  if (!risk) return false;
  const previous = risk.address;
  if (
    previous &&
    (await loadWallets()).some((w) => sameAddress(w.address, previous))
  ) {
    return false;
  }

  const { lines, noTerminal } = describeRisk(risk);
  for (const line of lines) console.log(line);
  requireInteractive("confirmation", noTerminal);
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
    const holds = previous ? `; it still holds ${previous}` : "";
    throw new Error(`aborted: .cmu-session was not changed${holds}.`);
  }
  return risk.kind !== "openable";
}

/**
 * Copies .cmu-session to .cmu-session.bak-<time>, owner-only. A copy, not a
 * move: the session stays in place until writeSessionFile's atomic rename
 * replaces it. "wx" refuses to overwrite an earlier backup of the same name.
 *
 * @returns {Promise<void>} Resolves once the copy is on disk.
 */
async function backUpSession(): Promise<void> {
  const file = getSessionFilePath();
  // ":" cannot appear in a Windows file name.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${file}${BACKUP_SUFFIX}${stamp}`;
  // A umask can only narrow the mode, and the copy is never rewritten.
  await writeFile(backup, await readFile(file), {
    mode: SESSION_FILE_MODE,
    flag: "wx",
  });
  console.log(`Kept the old session as ${path.basename(backup)}.`);
  console.log(
    `\x1b[2mhint:\x1b[0m it holds an encrypted key - keep it out of git: \`.cmu-session${BACKUP_SUFFIX}*\` in .gitignore.`,
  );
}

/**
 * Writes an encrypted key to .cmu-session, carrying the active network over.
 *
 * The one writer of a key into the session, so `use` keeps the network #126
 * was about, and passes the #182 check. The check runs first; `unlock` -
 * where every prompt for a key or password lives - only after it, so no
 * caller can ask for a secret before the user agreed to lose the old key.
 * A file the check could not prove keyless is backed up last, right before
 * the write, so a wrong password leaves no stray copy behind.
 *
 * @param {() => Promise<{address: string, encrypted: EncryptedKey}>} unlock -
 *   Prompts for whatever is needed and returns the key to store.
 * @returns {Promise<{address: string, activeNetwork: string}>} The address the
 *   session belongs to, and the network it ended up pointing at.
 */
export async function storeSession(
  unlock: () => Promise<{ address: string; encrypted: EncryptedKey }>,
): Promise<{ address: string; activeNetwork: string }> {
  const mustBackUp = await confirmSessionReplace();
  const { address, encrypted } = await unlock();
  const activeNetwork = await carriedOverNetwork();
  if (mustBackUp) await backUpSession();
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
 * there. A network-only session has no key to save here. One from before GCM
 * has no key `save --session` can keep, but still one to lose: see
 * keyAtRisk().
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
