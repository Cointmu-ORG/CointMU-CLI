import { existsSync, readFileSync } from "fs";
import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import * as path from "path";
import { Command } from "commander";
import { fail } from "../utils/errors";
import {
  confirmProjectTrust,
  findProjectConfig,
  loadProjectConfig,
} from "../utils/trust";

const JSON_SPACES = 2;
const DEFAULT_EVM_VERSION = "paris";

/**
 * Resolves imported Solidity files by reading their contents.
 * Required to be synchronous by the solc compiler import callback API.
 *
 * @param {string} importPath - The path of the imported Solidity file.
 * @returns {{ contents: string } | { error: string }} An object containing the file contents or an error message.
 */
export function findImports(
  importPath: string,
): { contents: string } | { error: string } {
  try {
    // True when `target` is strictly inside `root` (not root itself, not a sibling
    // whose name merely shares a string prefix, not an escape via "..").
    const isContained = (root: string, target: string): boolean => {
      const rel = path.relative(root, target);
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    };

    const cwd = process.cwd();
    const localPath = path.resolve(cwd, importPath);

    // Ensure the resolved path remains within the current working directory
    if (isContained(cwd, localPath) && existsSync(localPath)) {
      return { contents: readFileSync(localPath, "utf8") };
    }

    const nodeModulesRoot = path.resolve(cwd, "node_modules");
    const nodeModulesPath = path.resolve(nodeModulesRoot, importPath);
    if (
      isContained(nodeModulesRoot, nodeModulesPath) &&
      existsSync(nodeModulesPath)
    ) {
      return { contents: readFileSync(nodeModulesPath, "utf8") };
    }

    return { error: "File not found or access denied" };
  } catch {
    return { error: "File not found" };
  }
}

/**
 * Compiles all Solidity contracts found in the contracts directory.
 * Writes the artifacts to the artifacts directory.
 * @param {object} options - CLI options.
 * @returns {Promise<void>} Resolves when compilation finishes successfully.
 */
export async function runCompile(
  options: { verbose?: boolean; yes?: boolean } = {},
): Promise<void> {
  const solc = require("solc");

  const cwd = process.cwd();
  const contractsDir = path.resolve(cwd, "contracts");
  const artifactsDir = path.resolve(cwd, "artifacts");

  let compilerSettings: Record<string, unknown> = {};
  const configPath = findProjectConfig(cwd);

  if (configPath) {
    // require()ing the config runs project code, so gate it the same way
    // `cmu deploy` gates the scripts in deploy/.
    // readOnly: compile loads the config for its compiler settings and runs
    // nothing from deploy/, so no key is ever resolved or injected.
    await confirmProjectTrust([configPath], {
      yes: options.yes,
      readOnly: true,
    });
    try {
      const cmuConfig = await loadProjectConfig(configPath);
      compilerSettings = cmuConfig?.compiler?.settings ?? {};
    } catch {
      console.warn(
        `\x1b[33mwarning:\x1b[0m could not load ${path.basename(configPath)}; using default compiler settings.`,
      );
    }
  }

  if (!existsSync(contractsDir)) {
    throw new Error(
      "contracts/ directory not found.\n" +
        "\x1b[2mhint:\x1b[0m run `cmu compile` from the root of your CointMU project.",
    );
  }

  const files = await readdir(contractsDir);
  const solFiles = files.filter((f: string) => f.endsWith(".sol"));

  if (solFiles.length === 0) {
    console.log("No Solidity files found in contracts/.");
    return;
  }

  const sources: Record<string, { content: string }> = {};
  for (const file of solFiles) {
    const filePath = path.join(contractsDir, file);
    const content = await readFile(filePath, "utf8");
    sources[file] = { content };
  }

  const finalSettings: Record<string, unknown> = {
    evmVersion: DEFAULT_EVM_VERSION,
    ...compilerSettings,
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object"],
      },
    },
  };

  const input = {
    language: "Solidity",
    sources,
    settings: finalSettings,
  };

  console.log(`Compiling ${solFiles.length} Solidity file(s)...`);
  const output = JSON.parse(
    solc.compile(JSON.stringify(input), { import: findImports }),
  );

  // Warnings arrive in the same list as errors; only an error stops the build.
  const errors: { severity: string; formattedMessage: string }[] =
    output.errors ?? [];
  for (const err of errors) {
    console.error(err.formattedMessage);
  }
  if (errors.some((err) => err.severity === "error")) {
    throw new Error(
      "compilation aborted on Solidity errors.\n" +
        "\x1b[2mhint:\x1b[0m fix the errors reported above, then run `cmu compile` again.",
    );
  }

  await mkdir(artifactsDir, { recursive: true });

  for (const file in output.contracts) {
    for (const contractName in output.contracts[file]) {
      const contract = output.contracts[file][contractName];
      const artifactPath = path.join(artifactsDir, `${contractName}.json`);
      await writeFile(
        artifactPath,
        `${JSON.stringify(contract, null, JSON_SPACES)}\n`,
      );
      console.log(`Compiled ${contractName}`);
    }
  }
}

export const compileCommand = new Command("compile")
  .description("Compile smart contracts into ABI and bytecode artifacts")
  .option(
    "-y, --yes",
    "Skip the confirmation prompt before executing project code",
  )
  .addHelpText(
    "after",
    "\ncmu.config.ts/js is executed as code from the project directory. Only\n" +
      "compile projects you trust; see the 'Trust Model' section of the README.",
  )
  .action((options: { yes?: boolean }, command) =>
    runCompile(options).catch(fail("compile", command.optsWithGlobals())),
  );
