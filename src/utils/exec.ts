import { spawn } from "child_process";
import { isAbsolute } from "path";
import { once } from "node:events";

/**
 * Runs a command to completion with its stdio inherited, rejecting when the
 * child cannot start or exits non-zero.
 *
 * The one copy of the win32 handling the CLI needs: npm and npx ship there as
 * .cmd shims, so the extension is added, and the shell stays off the way `cmu
 * update` keeps it off - a shell re-parses the arguments, and some of them are
 * file names out of the user's project. Anything that is not an npm shim is
 * passed as an absolute path (process.execPath), which needs neither.
 *
 * ponytail: "<cmd>.cmd" with shell:false, as in `cmu update`. If Node ever
 * refuses .cmd through spawn, resolve the shim and run it through
 * process.execPath rather than turning the shell on.
 *
 * @param {string} command - The executable, or an absolute path to one.
 * @param {string[]} args - The arguments to pass it.
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] - Child environment; inherited when absent.
 * @param {string} [options.label] - What to call the command in the failure
 *   message. Defaults to the command itself.
 * @returns {Promise<void>} Resolves when the child exits 0.
 * @throws {Error} When the child cannot start, or exits non-zero.
 */
export async function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; label?: string } = {},
): Promise<void> {
  const executable =
    process.platform === "win32" && !isAbsolute(command)
      ? `${command}.cmd`
      : command;

  const child = spawn(executable, args, {
    stdio: "inherit",
    env: options.env,
    shell: false,
  });

  // once() rejects on the child's "error" event as well, so an executable that
  // is not there surfaces as itself instead of waiting for a "close" that is
  // never coming.
  const [code] = await once(child, "close");
  if (code !== 0) {
    throw new Error(`${options.label ?? command} exited with code ${code}`);
  }
}
