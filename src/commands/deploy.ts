import { Command } from "commander";
import { printCliError } from "../utils/errors";
import { confirmProjectTrust, findProjectConfig } from "../utils/trust";

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const MIN_KEY_LENGTH = 10;
const MASK_START = 5;
const MASK_END = 4;
const NETWORK_TIMEOUT_MS = 3000;

interface DeployOptions {
  config?: boolean;
  ping?: boolean;
  network?: string;
  verbose?: boolean;
  yes?: boolean;
}

/**
 * Executes a deployment script using child_process.execSync.
 * @param {string} scriptPath - The absolute path to the script to execute.
 * @param {Record<string, string | undefined>} env - Environment variables to inject.
 * @returns {void}
 */
function runDeployScript(
  scriptPath: string,
  env: Record<string, string | undefined>,
): void {
  const { execFileSync } = require("child_process");
  const path = require("path");

  const ext = path.extname(scriptPath);
  const isWin = process.platform === "win32";
  const runner = ext === ".ts" ? "npx" : "node";
  const args = ext === ".ts" ? ["ts-node", scriptPath] : [scriptPath];

  console.log(`\n========================================`);
  console.log(`Running ${path.basename(scriptPath)}`);
  console.log(`========================================\n`);

  execFileSync(runner, args, {
    stdio: "inherit",
    env,
    shell: isWin,
  });
}

/**
 * Masks a private key for secure console output.
 * @param {string} pk - The private key to mask.
 * @returns {string} The masked private key.
 */
export function maskPrivateKey(pk: string): string {
  if (pk.length < MIN_KEY_LENGTH) return "***";
  return `${pk.substring(0, MASK_START)}...${pk.substring(pk.length - MASK_END)}`;
}

/**
 * Pings the given RPC URL to verify network connectivity.
 * @param {string} rpcUrl - The RPC URL to test.
 * @returns {Promise<void>} Resolves if connected, throws Error if unreachable.
 */
export async function pingNetwork(rpcUrl: string): Promise<void> {
  const { ethers } = await import("ethers");
  console.log(`Pinging ${rpcUrl}...`);
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const networkData: any = await Promise.race([
      provider.getNetwork(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), NETWORK_TIMEOUT_MS),
      ),
    ]);
    console.log(
      `Connected to '${networkData.name}' (chain ID ${networkData.chainId}).`,
    );
  } catch {
    throw new Error(
      `RPC endpoint ${rpcUrl} is unreachable (timed out after ${NETWORK_TIMEOUT_MS}ms).\n` +
        "\x1b[2mhint:\x1b[0m check the node is running and the endpoint is correct - `cmu network list`.",
    );
  }
}

/**
 * Executes the deployment process.
 * @param {DeployOptions} options - CLI deployment options.
 * @returns {Promise<void>} Resolves when all scripts are deployed.
 */
async function runDeploy(options: DeployOptions): Promise<void> {
  try {
    const path = await import("path");
    const fs = (await import("fs-extra")).default || (await import("fs-extra"));
    require("dotenv").config({ path: path.resolve(process.cwd(), ".env") });

    const deployDir = path.resolve(process.cwd(), "deploy");

    if (!(await fs.pathExists(deployDir))) {
      throw new Error(
        `deploy/ directory not found at ${deployDir}.\n` +
          "\x1b[2mhint:\x1b[0m run `cmu deploy` from the root of your CointMU project.",
      );
    }

    const files: string[] = await fs.readdir(deployDir);
    const scripts = files
      .filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
      .sort((a, b) => a.localeCompare(b));

    // --config / --ping exit before any deploy script runs; only the project
    // config is loaded on those paths.
    const dryRun = Boolean(options.config || options.ping);
    const configPath = findProjectConfig();
    await confirmProjectTrust(
      [
        ...(configPath ? [configPath] : []),
        ...(dryRun ? [] : scripts.map((s) => path.join(deployDir, s))),
      ],
      { yes: options.yes },
    );

    console.log("Compiling contracts...");
    const { runCompile } = await import("./compile");
    await runCompile({ yes: options.yes });

    const { getDeployNetwork } = await import("../utils/network");
    const network = await getDeployNetwork(options.network, {
      noPrompt: options.config || options.ping,
    });

    if (options.ping) {
      await pingNetwork(network.url);
      process.exit(EXIT_SUCCESS);
    }

    const privateKey = network.privateKey;

    if (process.env.PRIVATE_KEY) {
      delete process.env.PRIVATE_KEY;
    }

    if (!privateKey) {
      throw new Error(
        "no private key available for signing.\n" +
          "\x1b[2mhint:\x1b[0m run `cmu wallet login`, or set PRIVATE_KEY in .env or cmu.config.ts.",
      );
    }

    const { ethers } = await import("ethers");
    let wallet;
    try {
      wallet = new ethers.Wallet(privateKey);
    } catch {
      throw new Error(
        "invalid private key.\n" +
          "\x1b[2mhint:\x1b[0m expected a 32-byte hex key (0x-prefixed); run `cmu wallet login` to store one.",
      );
    }

    console.log(`\n--- Deploy configuration ---`);
    console.log(`Network      : ${network.name}`);
    console.log(`RPC endpoint : ${network.url}`);
    console.log(`Chain ID     : ${network.chainId}`);
    console.log(`Deployer     : ${wallet.address}`);
    if (options.config) {
      console.log(`Private key  : ${maskPrivateKey(privateKey)}`);
    }
    console.log(`----------------------------\n`);

    if (options.config) {
      process.exit(EXIT_SUCCESS);
    }

    if (scripts.length === 0) {
      console.log("No deploy scripts found in deploy/.");
      return;
    }

    console.log(
      `Found ${scripts.length} deploy script(s); running them in order...`,
    );

    const injectedEnv = {
      ...process.env,
      CMU_RPC_URL: network.url,
      CMU_CHAIN_ID: String(network.chainId),
      PRIVATE_KEY: privateKey,
    };

    for (const script of scripts) {
      const fullPath = path.join(deployDir, script);
      runDeployScript(fullPath, injectedEnv);
    }

    console.log("\nAll deploy scripts completed.");
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m deploy failed");

    printCliError(error, options.verbose);

    process.exit(EXIT_FAILURE);
  }
}

export const deployCommand = new Command("deploy")
  .description("Run the deploy scripts that broadcast contracts on-chain")
  .option("-c, --config", "Show the resolved deploy configuration and exit")
  .option("-p, --ping", "Ping the configured RPC endpoint and exit")
  .option("-n, --network <name>", "Network to deploy to")
  .option("-v, --verbose", "Print full stack traces on failure")
  .option(
    "-y, --yes",
    "Skip the confirmation prompt before executing project code",
  )
  .addHelpText(
    "after",
    "\nEvery script in deploy/ is executed as code and receives your decrypted\n" +
      "PRIVATE_KEY through the environment. Only deploy projects you trust; see the\n" +
      "'Trust Model' section of the README.",
  )
  .action(runDeploy);
