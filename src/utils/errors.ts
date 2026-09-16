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

/**
 * Builds the rejection handler every command ends with: name the command that
 * failed, print the error the way --verbose asked for, exit non-zero.
 *
 * Returned rather than called so a command handler reads
 * `run(options).catch(fail("network info", options))`, which keeps the
 * reporting out of the command body and off every early return inside it.
 *
 * @param {string} label - The command, as the user typed it ("network info").
 * @param {object} [options] - The command's options; only `verbose` is read.
 * @param {string} [hint] - Printed after the error, for a command that can say
 *   something useful about any way of failing (`node connect` can always
 *   suggest starting a node).
 * @returns {(error: unknown) => never} A handler that never returns.
 */
export function fail(
  label: string,
  options: { verbose?: boolean } = {},
  hint?: string,
): (error: unknown) => never {
  return (error: unknown): never => {
    console.error(`\n\x1b[31merror:\x1b[0m ${label} failed`);
    printCliError(error, options.verbose);
    if (hint) {
      console.error(`\x1b[2mhint:\x1b[0m ${hint}`);
    }
    process.exit(1);
  };
}
