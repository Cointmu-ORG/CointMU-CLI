import { spawn } from "child_process";
import { once } from "node:events";
import { resolveCommand } from "./npmCommand";

/** A child that started, then exited non-zero or was killed by a signal. */
export class CommandExitError extends Error {
  /** The exit code; null when a signal ended the child. */
  readonly exitCode: number | null;

  constructor(label: string, exitCode: number | null) {
    super(`${label} exited with code ${exitCode}`);
    this.exitCode = exitCode;
  }
}

/**
 * Wraps the error of a tool that never started (not on PATH, refused by
 * spawn, no npm entry script) in one that names the tool and the way out.
 * Spawn errors do not always name the tool themselves: on Windows, refusing a
 * .cmd reports only "spawn EINVAL".
 *
 * @param {string} tool - The tool as the user knows it ("npm").
 * @param {unknown} error - Why it did not start; kept as `cause`.
 * @param {string} rerun - The command to run again once it is fixed.
 * @returns {Error} The error to throw.
 */
export function startFailure(
  tool: string,
  error: unknown,
  rerun: string,
): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `${tool} could not be started: ${reason}\n` +
      `\x1b[2mhint:\x1b[0m make sure Node.js and its npm are installed and on PATH, ` +
      `then run \`${rerun}\` again.`,
    { cause: error },
  );
}

/**
 * Runs a command to completion with its stdio inherited, rejecting when the
 * child cannot start or exits non-zero.
 *
 * The shell stays off: it would re-parse the arguments, and some of them are
 * file names out of the user's project. On Windows that rules out npm's .cmd
 * shims, so resolveCommand() swaps npm and npx for their entry scripts run
 * through process.execPath; it reads this process's PATH, not `options.env`.
 *
 * @param {string} command - The executable, or an absolute path to one.
 * @param {string[]} args - The arguments to pass it.
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] - Child environment; inherited when absent.
 * @param {string} [options.cwd] - Child working directory; inherited when absent.
 * @param {string} [options.label] - What to call the command in the failure
 *   message. Defaults to the command itself.
 * @returns {Promise<void>} Resolves when the child exits 0.
 * @throws {CommandExitError} When the child exits non-zero.
 * @throws {Error} When the child cannot start.
 */
export async function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; label?: string } = {},
): Promise<void> {
  const resolved = resolveCommand(command, args);

  const child = spawn(resolved.file, resolved.args, {
    stdio: "inherit",
    env: options.env,
    cwd: options.cwd,
    shell: false,
  });

  // once() rejects on the child's "error" event as well, so an executable that
  // is not there surfaces as itself instead of waiting for a "close" that is
  // never coming.
  const [code] = await once(child, "close");
  if (code !== 0) {
    throw new CommandExitError(options.label ?? command, code);
  }
}
