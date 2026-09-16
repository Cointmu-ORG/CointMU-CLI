import { homedir } from "os";
import { inspect } from "util";

/** Shell convention for the current user's home directory. */
const HOME_PLACEHOLDER = "~";

/**
 * Replaces the current user's home directory with `~` anywhere in the given
 * text. Verbose error output carries absolute paths through stack frames and
 * file-system error messages; `~` is what a shell would show and loses nothing
 * a local developer needs to debug.
 *
 * @param {string} text - The text about to be printed.
 * @returns {string} The same text with the home directory replaced.
 */
export function scrubHomeDir(text: string): string {
  const home = homedir();
  // A missing or degenerate homedir ("", "/") would turn every path separator
  // into "~". Leave the text alone rather than mangle it.
  if (!home || home.length < 2) {
    return text;
  }
  return text.replaceAll(home, HOME_PLACEHOLDER);
}

/**
 * Prints a caught error for the CLI's standard catch blocks.
 *
 * With --verbose the error is inspected the way console.error would render it,
 * so stack frames and the extra properties ethers and Node attach to their
 * errors are preserved; otherwise only the message is shown. Both forms are
 * scrubbed, because plain messages carry absolute paths just as often as
 * stack traces do ("ENOENT ... open '/home/you/project/...'").
 *
 * @param {unknown} error - The caught value.
 * @param {boolean} [verbose] - Whether --verbose was passed.
 * @returns {void}
 */
export function printCliError(error: unknown, verbose?: boolean): void {
  const text = verbose
    ? inspect(error)
    : error instanceof Error
      ? error.message
      : String(error);
  console.error(scrubHomeDir(text));
}
