import { Command } from "commander";
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
  console.log(`Executing: ${path.basename(scriptPath)}`);
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
  console.log(`Pinging RPC URL: ${rpcUrl}...`);
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const networkData: any = await Promise.race([
      provider.getNetwork(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), NETWORK_TIMEOUT_MS),
      ),
    ]);
    console.log(
      `[SUCCESS] Connected to network '${networkData.name}' (Chain ID: ${networkData.chainId})`,
    );
  } catch {
    throw new Error(`Unreachable RPC URL: ${rpcUrl}`);
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
        `'deploy' directory not found at ${deployDir}.\nPlease run this command from the root of your CointMU project.`,
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

    console.log("Triggering automated contract compilation...");
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
        "PRIVATE_KEY is not defined in the configuration or .env file.",
      );
    }

    const { ethers } = await import("ethers");
    let wallet;
    try {
      wallet = new ethers.Wallet(privateKey);
    } catch {
      throw new Error("Invalid PRIVATE_KEY provided.");
    }

    console.log(`\n--- Deployment Metadata ---`);
    console.log(`Network Name  : ${network.name}`);
    console.log(`RPC URL       : ${network.url}`);
    console.log(`Chain ID      : ${network.chainId}`);
    console.log(`Deployer      : ${wallet.address}`);
    if (options.config) {
      console.log(`Private Key   : ${maskPrivateKey(privateKey)}`);
    }
    console.log(`---------------------------\n`);

    if (options.config) {
      process.exit(EXIT_SUCCESS);
    }

    if (scripts.length === 0) {
      console.log("No deployment scripts found in deploy/ directory.");
      return;
    }

    console.log(
      `Found ${scripts.length} deployment script(s). Starting sequential deployment...`,
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

    console.log("\nAll deployment scripts executed successfully.");
  } catch (error) {
    console.error("\n\x1b[31m[!] Deployment failed:\x1b[0m");

    if (options.verbose) {
      console.error(error);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }

    process.exit(EXIT_FAILURE);
  }
}

export const deployCommand = new Command("deploy")
  .description("Executes deployment scripts to broadcast contracts on-chain")
  .option(
    "-c, --config",
    "Display the current deployment configuration and exit",
  )
  .option(
    "-p, --ping",
    "Ping the configured RPC network to check connectivity and exit",
  )
  .option("-n, --network <name>", "Specify the network to deploy to")
  .option("-v, --verbose", "Enable verbose logging for debugging")
  .option(
    "-y, --yes",
    "Skip the confirmation prompt before executing project code",
  )
  .addHelpText(
    "after",
    "\nWarning: every script in deploy/ is executed as code and receives your\n" +
      "decrypted PRIVATE_KEY via the environment. Only deploy projects you trust.\n" +
      "See the README 'Trust Model' section.",
  )
  .action(runDeploy);
