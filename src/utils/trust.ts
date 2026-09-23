import * as fs from "fs";
import * as path from "path";

export const TS_CONFIG_FILE = "cmu.config.ts";
export const JS_CONFIG_FILE = "cmu.config.js";

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
 * require()s a config found by findProjectConfig(), registering ts-node first
 * when it is TypeScript. This runs project code: confirmProjectTrust() must
 * have been passed the same path before this is called.
 *
 * `compiler` is the bare package name "typescript" on purpose. ts-node
 * resolves that with its own project-local resolver, relative to the project
 * being loaded, which is where TypeScript actually lives - this CLI does not
 * depend on typescript at runtime, so resolving it relative to the CLI's own
 * install would find nothing in a global install.
 *
 * An earlier version passed "typescript@5", which is an npm install spec that
 * require() cannot resolve, and every TypeScript project failed to load
 * (64b2875). Keep this in one place so that fix cannot drift back out of one
 * of the call sites.
 *
 * @param {string} configPath - Absolute path to cmu.config.ts or cmu.config.js.
 * @returns {Promise<any>} The config's default export, or the module itself.
 */
export async function loadProjectConfig(configPath: string): Promise<any> {
  if (configPath.endsWith(".ts")) {
    const tsNode = await import("ts-node");
    tsNode.register({
      transpileOnly: true,
      compiler: "typescript",
      compilerOptions: { module: "CommonJS" },
    });
  }
  const mod = require(configPath);
  return mod?.default ?? mod;
}

/**
 * One confirmation per CLI process. `cmu deploy` gates up front and then calls
 * runCompile(), which gates again; without this the user would be asked twice
 * about the same project.
 */
let confirmed = false;

/**
 * Shows every project file that is about to be executed as code and requires
 * explicit confirmation before it runs.
 *
 * Deploy scripts receive the decrypted PRIVATE_KEY through the environment, and
 * cmu.config.ts is `require()`d from the cwd, so both are arbitrary code
 * execution from the project directory. That is by design (the same trust model
 * as Hardhat/Foundry/Truffle), but it should never happen silently.
 *
 * Only `deploy` and `console` resolve a key, so only they get the sentence
 * about an injected PRIVATE_KEY. `compile` and `explorer` pass readOnly and get
 * wording that claims no more than they do: a gate that overstates its stakes
 * on the quiet commands is a gate people learn to dismiss on `cmu deploy`,
 * where the warning is literally true.
 *
 * In a non-interactive session there is no one to answer the prompt, so this
 * throws instead of auto-continuing: silently bypassing the gate wherever
 * stdin is not a TTY would make the confirmation meaningless in exactly the
 * environments (CI, scripts) where a hostile project is least likely to be
 * noticed.
 *
 * @param {(string | null)[]} targets - Absolute paths of the files that will
 *   execute. A null - findProjectConfig() finding no config - is skipped, so
 *   callers can pass its result straight in.
 * @param {object} [options]
 * @param {boolean} [options.yes] - Skip the prompt (`--yes`).
 * @param {boolean} [options.readOnly] - Print the wording for a command that
 *   loads the config but never resolves a key (`compile`, `explorer`).
 * @returns {Promise<void>} Resolves when execution is authorised.
 */
export async function confirmProjectTrust(
  targets: (string | null)[],
  options: { yes?: boolean; readOnly?: boolean } = {},
): Promise<void> {
  const files = targets.filter((target) => target !== null);
  if (confirmed || files.length === 0) return;

  console.log(
    "\n\x1b[33mwarning:\x1b[0m the following project files will be executed as code:",
  );
  for (const target of files) {
    console.log(`      ${path.basename(target)}  ->  ${target}`);
  }
  console.log(
    options.readOnly
      ? "\n    They are require()d as code to read this project's configuration, run with\n" +
          "    your full environment, and can do anything your user account can. This\n" +
          "    command does not sign anything and does not unlock your session. This is the\n" +
          "    same trust model as Hardhat, Foundry and Truffle; see the 'Trust Model'\n" +
          "    section of the README.\n"
      : "\n    They run with your full environment, including the PRIVATE_KEY decrypted from\n" +
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
