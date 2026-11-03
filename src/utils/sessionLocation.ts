import { existsSync } from "fs";
import { homedir } from "os";
import * as path from "path";

const SESSION_FILE_NAME = ".cmu-session";

/** How messages name the global session file. */
const GLOBAL_LABEL = `~/${SESSION_FILE_NAME}`;
/** How messages name a working folder's override. */
const LOCAL_LABEL = `./${SESSION_FILE_NAME}`;

/**
 * The working folder's .cmu-session: the per-project override.
 *
 * Resolved on every call rather than memoised at import time: the CLI reads it
 * relative to the working directory, and tests stub process.cwd().
 *
 * @returns {string} The absolute path, whether or not the file exists.
 */
export function getLocalSessionFilePath(): string {
  return path.resolve(process.cwd(), SESSION_FILE_NAME);
}

/**
 * ~/.cmu-session: the session every folder without its own override uses.
 * Lives next to ~/.cmu-wallets.json, and like it is resolved per call: tests
 * point HOME (USERPROFILE on Windows) at a temp directory.
 *
 * @returns {string} The absolute path, whether or not the file exists.
 */
export function getGlobalSessionFilePath(): string {
  return path.join(homedir(), SESSION_FILE_NAME);
}

/**
 * The session file in effect: the working folder's .cmu-session when it
 * exists, otherwise ~/.cmu-session. Every read of the session, and every
 * write that does not choose its own target, goes through this - so the
 * active wallet and the active network always come from the same file.
 *
 * @returns {string} The absolute path to the session file in effect.
 */
export function getSessionFilePath(): string {
  const local = getLocalSessionFilePath();
  return existsSync(local) ? local : getGlobalSessionFilePath();
}

/**
 * How messages name a session file, so a confirmation, a backup or a hint
 * says which of the two it is about. Run from the home directory, the two
 * are the same file, and it is called the global one.
 *
 * @param {string} filePath - A path from one of the functions above.
 * @returns {string} `~/.cmu-session` or `./.cmu-session`.
 */
export function describeSessionFile(filePath: string): string {
  return filePath === getGlobalSessionFilePath() ? GLOBAL_LABEL : LOCAL_LABEL;
}
