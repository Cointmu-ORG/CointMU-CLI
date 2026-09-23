import { existsSync } from "fs";
import { readdir } from "fs/promises";
import * as path from "path";
import { Command } from "commander";
import { fail } from "../utils/errors";
import { run } from "../utils/exec";
import { getDeployNetwork } from "../utils/network";
import { confirmProjectTrust, findProjectConfig } from "../utils/trust";
import { runCompile } from "./compile";

const NETWORK_TIMEOUT_MS = 3000;

interface DeployOptions {
  config?: boolean;
  ping?: boolean;
  network?: string;
  verbose?: boolean;
  yes?: boolean;
}

/**
 * Runs one deploy script as its own process.
 *
 * A .js script runs on the same Node that runs the CLI (process.execPath), not
 * on whichever "node" is first on PATH; a .ts one goes through ts-node.
 *
 * @param {string} scriptPath - The absolute path to the script to execute.
 * @param {NodeJS.ProcessEnv} env - Environment variables to inject.
 * @returns {Promise<void>} Resolves when the script exits 0.
 * @throws {Error} When the script exits non-zero, so the run stops there.
 */
async function runDeployScript(
  scriptPath: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const isTypeScript = path.extname(scriptPath) === ".ts";

  console.log(`\n========================================`);
  console.log(`Running ${path.basename(scriptPath)}`);
  console.log(`========================================\n`);

  await run(
    isTypeScript ? "npx" : process.execPath,
    isTypeScript ? ["ts-node", scriptPath] : [scriptPath],
    { env, label: path.basename(scriptPath) },
  );
}

/** Stands in for the deployer address when `--config` finds no key. */
const NO_KEY_LABEL = "unavailable (no key)";

/**
 * Masks a private key for console output: the 0x plus three digits that make a
 * key recognisable, and the last four. Anything too short to keep that much
 * hidden is redacted outright.
 *
 * @param {string} pk - The private key to mask.
 * @returns {string} The masked private key.
 */
export function maskPrivateKey(pk: string): string {
  if (pk.length < 10) return "***";
  return `${pk.substring(0, 5)}...${pk.substring(pk.length - 4)}`;
}

/**
 * Pings the given RPC URL to verify network connectivity.
 * @param {string} rpcUrl - The RPC URL to test.
 * @param {string} [name] - The resolved network name, as the caller knows it.
 *   ethers has no registered name for the CointMU chain, so without this the
 *   connection is reported as 'unknown'.
 * @returns {Promise<void>} Resolves if connected, throws Error if unreachable.
 */
export async function pingNetwork(
  rpcUrl: string,
  name?: string,
): Promise<void> {
  // An unset url is a config error, not an unreachable endpoint: dialing "" only
  // buys the user a NETWORK_TIMEOUT_MS wait and a message with a hole in it. The
  // stock `cmu create` scaffold ships `mainnet` with url: "", so this is a
  // first-run mistake, not an exotic one.
  if (!rpcUrl) {
    throw new Error(
      "the resolved network has no url.\n" +
        "\x1b[2mhint:\x1b[0m set `url` for this network in cmu.config.ts.",
    );
  }

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
      `Connected to '${name ?? networkData.name}' (chain ID ${networkData.chainId}).`,
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
 *
 * Never calls process.exit() itself, so the --config and --ping paths can be
 * exercised without stubbing it. The single exit lives in the command handler
 * below.
 *
 * @param {DeployOptions} options - CLI deployment options.
 * @returns {Promise<void>} Resolves when the run is finished.
 * @throws {Error} When the deployment cannot proceed.
 */
export async function runDeploy(options: DeployOptions): Promise<void> {
  const deployDir = path.resolve(process.cwd(), "deploy");

  if (!existsSync(deployDir)) {
    throw new Error(
      `deploy/ directory not found at ${deployDir}.\n` +
        "\x1b[2mhint:\x1b[0m run `cmu deploy` from the root of your CointMU project.",
    );
  }

  const files = await readdir(deployDir);
  const scripts = files
    .filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
    .sort((a, b) => a.localeCompare(b));

  // --config / --ping exit before any deploy script runs; only the project
  // config is loaded on those paths.
  const dryRun = Boolean(options.config || options.ping);
  await confirmProjectTrust(
    [
      findProjectConfig(),
      ...(dryRun ? [] : scripts.map((s) => path.join(deployDir, s))),
    ],
    { yes: options.yes },
  );

  console.log("Compiling contracts...");
  // Compile failures keep reporting themselves as "compile failed" rather than
  // being relabelled by the command that triggered the compile.
  await runCompile({ yes: options.yes }).catch(fail("compile", options));

  const network = await getDeployNetwork(options.network, {
    noPrompt: options.config || options.ping,
  });

  if (options.ping) {
    await pingNetwork(network.url, network.name);
    return;
  }

  const privateKey = network.privateKey;

  delete process.env.PRIVATE_KEY;

  // --config prints what was resolved and stops; it never signs, so a project
  // whose only key sits in a locked .cmu-session still has a configuration
  // worth showing. Everything past the config block below does sign.
  if (!privateKey && !options.config) {
    throw new Error(
      "no private key available for signing.\n" +
        "\x1b[2mhint:\x1b[0m run `cmu wallet login`, or set PRIVATE_KEY in .env or cmu.config.ts.",
    );
  }

  const { ethers } = await import("ethers");
  let wallet;
  if (privateKey) {
    try {
      wallet = new ethers.Wallet(privateKey);
    } catch {
      throw new Error(
        "invalid private key.\n" +
          "\x1b[2mhint:\x1b[0m expected a 32-byte hex key (0x-prefixed); run `cmu wallet login` to store one.",
      );
    }
  }

  console.log(`\n--- Deploy configuration ---`);
  console.log(`Network      : ${network.name}`);
  console.log(`RPC endpoint : ${network.url}`);
  console.log(`Chain ID     : ${network.chainId}`);
  // Kept as a field rather than dropped: the line existing but reading
  // "unavailable" is what tells the user no key was found, not a gap.
  console.log(`Deployer     : ${wallet ? wallet.address : NO_KEY_LABEL}`);
  if (options.config) {
    console.log(
      `Private key  : ${privateKey ? maskPrivateKey(privateKey) : NO_KEY_LABEL}`,
    );
  }
  console.log(`----------------------------\n`);

  if (options.config) {
    return;
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
    await runDeployScript(fullPath, injectedEnv);
  }

  console.log("\nAll deploy scripts completed.");
}

export const deployCommand = new Command("deploy")
  .description("Run the deploy scripts that broadcast contracts on-chain")
  .option("-c, --config", "Show the resolved deploy configuration and exit")
  .option("-p, --ping", "Ping the configured RPC endpoint and exit")
  .option("-n, --network <name>", "Network to deploy to")
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
  .action((options: DeployOptions, command) => {
    // runDeploy reports its own compile step, so it needs the inherited
    // --verbose too, not just the options declared on `deploy` itself.
    const opts = command.optsWithGlobals() as DeployOptions;
    return runDeploy(opts).then(() => process.exit(0), fail("deploy", opts));
  });
