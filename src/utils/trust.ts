import * as fs from "fs";
import * as path from "path";

const TS_CONFIG_FILE = "cmu.config.ts";
const JS_CONFIG_FILE = "cmu.config.js";

/**
 * Locates the project's cmu.config file, preferring the TypeScript variant.
 * This file is `require()`d from the current working directory, so it is
 * arbitrary code and must be covered by confirmProjectTrust().
 *
 * @param {string} [cwd] - Directory to look in. Defaults to process.cwd().
 * @returns {string | null} Absolute path to the config file, or null.
 */
export function findProjectConfig(cwd: string = process.cwd()): string | null {
  const tsPath = path.resolve(cwd, TS_CONFIG_FILE);
  if (fs.existsSync(tsPath)) return tsPath;
  const jsPath = path.resolve(cwd, JS_CONFIG_FILE);
  return fs.existsSync(jsPath) ? jsPath : null;
}

/**
 * One confirmation per CLI process. `cmu deploy` gates up front and then calls
 * runCompile(), which gates again; without this the user would be asked twice
 * about the same project.
 */
let confirmed = false;

/** Clears the per-process confirmation memo. Exposed for tests. */
export function resetTrustConfirmation(): void {
  confirmed = false;
}

/**
 * Shows every project file that is about to be executed as code and requires
 * explicit confirmation before it runs.
 *
 * Deploy scripts receive the decrypted PRIVATE_KEY through the environment, and
 * cmu.config.ts is `require()`d from the cwd, so both are arbitrary code
 * execution from the project directory. That is by design (the same trust model
 * as Hardhat/Foundry/Truffle), but it should never happen silently.
 *
 * In a non-interactive session there is no one to answer the prompt, so this
 * throws instead of auto-continuing: silently bypassing the gate wherever
 * stdin is not a TTY would make the confirmation meaningless in exactly the
 * environments (CI, scripts) where a hostile project is least likely to be
 * noticed.
 *
 * @param {string[]} targets - Absolute paths of the files that will execute.
 * @param {object} [options]
 * @param {boolean} [options.yes] - Skip the prompt (`--yes`).
 * @returns {Promise<void>} Resolves when execution is authorised.
 */
export async function confirmProjectTrust(
  targets: string[],
  options: { yes?: boolean } = {},
): Promise<void> {
  if (confirmed || targets.length === 0) return;

  console.log(
    "\n\x1b[33mwarning:\x1b[0m the following project files will be executed as code:",
  );
  for (const target of targets) {
    console.log(`      ${path.basename(target)}  ->  ${target}`);
  }
  console.log(
    "\n    They run with your full environment, including the PRIVATE_KEY decrypted from\n" +
      "    your session and injected for deploy scripts, and can do anything your user\n" +
      "    account can. This is the same trust model as Hardhat, Foundry and Truffle;\n" +
      "    see the 'Trust Model' section of the README.\n",
  );

  if (options.yes) {
    console.log("    --yes: continuing without confirmation\n");
    confirmed = true;
    return;
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      "refusing to execute project code without confirmation in a non-interactive session.\n" +
        "\x1b[2mhint:\x1b[0m re-run with --yes if you trust the files listed above.",
    );
  }

  const inquirer = (await import("inquirer")).default;
  const { proceed } = await inquirer.prompt([
    {
      type: "confirm",
      name: "proceed",
      message: "Execute these files?",
      default: false,
    },
  ]);

  if (!proceed) {
    throw new Error("aborted: no project code was executed");
  }
  confirmed = true;
}
