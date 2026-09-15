import { Command } from "commander";
import { confirmProjectTrust, findProjectConfig } from "../utils/trust";

const EXIT_FAILURE = 1;
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
    const fs = require("fs");
    const path = require("path");

    // True when `target` is strictly inside `root` (not root itself, not a sibling
    // whose name merely shares a string prefix, not an escape via "..").
    const isContained = (root: string, target: string): boolean => {
      const rel = path.relative(root, target);
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    };

    const cwd = process.cwd();
    const localPath = path.resolve(cwd, importPath);

    // Ensure the resolved path remains within the current working directory
    if (isContained(cwd, localPath) && fs.existsSync(localPath)) {
      return { contents: fs.readFileSync(localPath, "utf8") };
    }

    const nodeModulesRoot = path.resolve(cwd, "node_modules");
    const nodeModulesPath = path.resolve(nodeModulesRoot, importPath);
    if (
      isContained(nodeModulesRoot, nodeModulesPath) &&
      fs.existsSync(nodeModulesPath)
    ) {
      return { contents: fs.readFileSync(nodeModulesPath, "utf8") };
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
  try {
    const fs = require("fs-extra");
    const solc = require("solc");
    const path = require("path");

    const cwd = process.cwd();
    const contractsDir = path.resolve(cwd, "contracts");
    const artifactsDir = path.resolve(cwd, "artifacts");

    let compilerSettings: Record<string, unknown> = {};
    const configPath = findProjectConfig(cwd);

    if (configPath) {
      // require()ing the config runs project code, so gate it the same way
      // `cmu deploy` gates the scripts in deploy/.
      await confirmProjectTrust([configPath], { yes: options.yes });
      try {
        if (configPath.endsWith(".ts")) {
          require("ts-node/register/transpile-only");
        }
        const loadedConfig = require(configPath);
        const cmuConfig = loadedConfig?.default ?? loadedConfig;
        compilerSettings = cmuConfig?.compiler?.settings ?? {};
      } catch {
        console.warn(
          `Warning: failed to load ${path.basename(configPath)}. Using defaults.`,
        );
      }
    }

    if (!(await fs.pathExists(contractsDir))) {
      throw new Error(
        "contracts directory not found. Are you in a CointMU project?",
      );
    }

    const files: string[] = await fs.readdir(contractsDir);
    const solFiles = files.filter((f: string) => f.endsWith(".sol"));

    if (solFiles.length === 0) {
      console.log("No Solidity files found to compile.");
      return;
    }

    const sources: Record<string, { content: string }> = {};
    for (const file of solFiles) {
      const filePath = path.join(contractsDir, file);
      const content = await fs.readFile(filePath, "utf8");
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

    console.log("Compiling contracts...");
    const output = JSON.parse(
      solc.compile(JSON.stringify(input), { import: findImports }),
    );

    if (output.errors) {
      let hasError = false;
      for (const err of output.errors) {
        console.error(err.formattedMessage);
        if (err.severity === "error") hasError = true;
      }
      if (hasError) {
        throw new Error("Compilation failed due to Solidity errors.");
      }
    }

    await fs.ensureDir(artifactsDir);

    for (const file in output.contracts) {
      for (const contractName in output.contracts[file]) {
        const contract = output.contracts[file][contractName];
        const artifactPath = path.join(artifactsDir, `${contractName}.json`);
        await fs.writeJson(artifactPath, contract, { spaces: JSON_SPACES });
        console.log(`Compiled ${contractName} successfully.`);
      }
    }
  } catch (error) {
    console.error(
      "\n\x1b[31m[!] Compilation failed to execute completely.\x1b[0m",
    );

    if (options.verbose) {
      console.error(error);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }

    process.exit(EXIT_FAILURE);
  }
}

export const compileCommand = new Command("compile")
  .description("Compiles smart contracts into ABI and bytecode artifacts")
  .option("-v, --verbose", "Enable verbose logging for debugging")
  .option(
    "-y, --yes",
    "Skip the confirmation prompt before executing project code",
  )
  .addHelpText(
    "after",
    "\nWarning: cmu.config.ts/js is executed as code from the project directory.\n" +
      "Only compile projects you trust. See the README 'Trust Model' section.",
  )
  .action(async (options: { verbose?: boolean; yes?: boolean }) => {
    await runCompile(options);
  });
