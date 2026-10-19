import { existsSync } from "fs";
import path from "path";

/** The shim npm puts on PATH on Windows. Only its directory is used. */
const NPM_SHIM = "npm.cmd";

/** Where an npm install keeps its JS entry points, under the shim's directory. */
const NPM_BIN_DIR = ["node_modules", "npm", "bin"] as const;

/** The entry script each npm shim runs. */
const ENTRY_SCRIPTS: ReadonlyMap<string, string> = new Map([
  ["npm", "npm-cli.js"],
  ["npx", "npx-cli.js"],
]);

/** What the resolver reads from the running process; injected in tests. */
export interface CommandHost {
  readonly platform: NodeJS.Platform;
  /** This process's PATH, never a child's env (see resolveCommand). */
  readonly pathEnv: string | undefined;
  readonly execPath: string;
  readonly exists: (file: string) => boolean;
}

/** The executable to spawn and the arguments to spawn it with. */
export interface ResolvedCommand {
  readonly file: string;
  readonly args: string[];
}

/** Neither place an npm install keeps its entry scripts has the one asked for. */
export class NpmEntryNotFoundError extends Error {
  constructor(script: string, searched: readonly string[]) {
    super(`cannot find ${script}: searched ${searched.join(", then ")}`);
  }
}

/** @returns {CommandHost} The running process, as the resolver sees it. */
export function currentHost(): CommandHost {
  return {
    platform: process.platform,
    pathEnv: process.env.PATH,
    execPath: process.execPath,
    exists: existsSync,
  };
}

/**
 * Turns a command into something spawn() can start without a shell.
 *
 * On Windows, npm and npx are .cmd shims, and since CVE-2024-27980 Node
 * refuses to spawn a .cmd without a shell (EINVAL). A shell would re-parse the
 * arguments, some of which are file names out of the user's project, so the
 * shim is skipped instead: its JS entry script runs on the Node running the
 * CLI. The script is looked for beside the first npm.cmd on PATH, the way the
 * shim finds it, then beside process.execPath. Every other command, and every
 * command on other platforms, is returned as given.
 *
 * PATH is this process's own (process.env.PATH), not the PATH of any env a
 * caller hands the child: on Windows process.env looks keys up regardless of
 * case, while a `{ ...process.env }` copy keeps the key as "Path", where a
 * lookup of "PATH" finds nothing.
 *
 * ponytail: npm.cmd first asks npm-prefix.js for the global prefix and prefers
 * an npm upgraded there (`npm i -g npm`); this runs the npm beside the shim. To
 * follow it, run npm-prefix.js through execPath and look in that prefix first.
 *
 * @param {string} command - The command as the caller names it ("npm").
 * @param {readonly string[]} args - Its arguments; each stays one element.
 * @param {CommandHost} [host] - The process to resolve for.
 * @returns {ResolvedCommand} The file and arguments to pass to spawn().
 * @throws {NpmEntryNotFoundError} On Windows, when neither place has the
 *   entry script.
 */
export function resolveCommand(
  command: string,
  args: readonly string[],
  host: CommandHost = currentHost(),
): ResolvedCommand {
  const script = ENTRY_SCRIPTS.get(command);
  if (host.platform !== "win32" || script === undefined) {
    return { file: command, args: [...args] };
  }
  return {
    file: host.execPath,
    args: [findEntryScript(script, host), ...args],
  };
}

/**
 * @param {string} script - The entry script's file name.
 * @param {CommandHost} host - The process to resolve for.
 * @returns {string} The entry script's absolute path.
 * @throws {NpmEntryNotFoundError} When neither place has it.
 */
function findEntryScript(script: string, host: CommandHost): string {
  const shimDir = findShimDir(host.pathEnv, host.exists);
  const nodeDir = path.win32.dirname(host.execPath);
  const binDirs = [shimDir, nodeDir]
    .filter((dir) => dir !== undefined)
    .map((dir) => path.win32.join(dir, ...NPM_BIN_DIR));

  const found = binDirs
    .map((dir) => path.win32.join(dir, script))
    .find(host.exists);
  if (found !== undefined) {
    return found;
  }

  const nodeBinDir = binDirs[binDirs.length - 1];
  throw new NpmEntryNotFoundError(script, [
    shimDir === undefined
      ? `no ${NPM_SHIM} on PATH`
      : `${binDirs[0]} (beside the first ${NPM_SHIM} on PATH)`,
    `${nodeBinDir} (beside the running node)`,
  ]);
}

/**
 * Relative and empty PATH entries are skipped: they would let the current
 * directory, which can be the user's project with its own node_modules, stand
 * in for npm.
 *
 * @param {string | undefined} pathEnv - A Windows PATH value.
 * @param {(file: string) => boolean} exists - The file-existence check.
 * @returns {string | undefined} The first directory holding npm.cmd, if any.
 */
function findShimDir(
  pathEnv: string | undefined,
  exists: (file: string) => boolean,
): string | undefined {
  return (pathEnv ?? "")
    .split(path.win32.delimiter)
    .map((entry) => entry.replace(/^"(.*)"$/, "$1"))
    .filter((dir) => path.win32.isAbsolute(dir))
    .find((dir) => exists(path.win32.join(dir, NPM_SHIM)));
}
