import { existsSync, readdirSync } from "fs";
import * as path from "path";
import { Command } from "commander";
import { fail, printCliError } from "../utils/errors";
import { run } from "../utils/exec";
import {
  bootHardhat,
  requireEdrNode,
  silenceHardhatNoise,
} from "../utils/hardhat";
import { startRpcProxy } from "../utils/rpcProxy";
import { LOCAL_CHAIN_ID } from "../utils/defaults";

const TEST_PORT = 8555;
const TEST_HOST = "127.0.0.1";
const TEST_DIR_NAME = "test";

/**
 * Prints per-transaction gas usage for every block the test run produced.
 *
 * Reporting is a convenience, not part of the run: a failure here is downgraded
 * to a warning so it never masks the test result that was already decided.
 *
 * @param {number} port - Port the test RPC proxy is listening on.
 * @param {object} [options]
 * @param {boolean} [options.verbose] - Print the full error if the report fails.
 * @returns {Promise<void>} Always resolves.
 */
export async function printGasReport(
  port: number,
  options: { verbose?: boolean } = {},
): Promise<void> {
  const RULE =
    "=========================================================================================";
  const THIN_RULE =
    "-----------------------------------------------------------------------------------------";

  try {
    console.log(`\n${RULE}`);
    console.log("Gas profile");
    console.log(RULE);
    console.log(
      "| Block | Transaction Hash                                                   | Gas Used |",
    );
    console.log(THIN_RULE);

    const { ethers } = await import("ethers");
    const rpcProvider = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`);
    const latestBlock = await rpcProvider.getBlockNumber();
    let totalGas = 0n;

    for (let i = 1; i <= latestBlock; i++) {
      const block = await rpcProvider.getBlock(i);
      if (!block?.transactions) continue;

      for (const txHash of block.transactions) {
        const receipt = await rpcProvider.getTransactionReceipt(txHash);
        if (!receipt) continue;

        totalGas += receipt.gasUsed;
        console.log(
          `| ${i.toString().padEnd(5)} | ${txHash} | ${receipt.gasUsed.toString().padEnd(8)} |`,
        );
      }
    }

    console.log(THIN_RULE);
    console.log(`Total gas used: ${totalGas.toString()}\n`);
  } catch (error) {
    console.error(
      "\x1b[33mwarning:\x1b[0m could not produce the gas report; the tests themselves were unaffected.",
    );
    if (options.verbose) {
      printCliError(error, true);
    }
  }
}

/**
 * Runs the project's mocha suite against the test RPC proxy.
 *
 * The runner is picked from what is in test/: a TypeScript suite needs
 * ts-node/register, a JavaScript one must not have it.
 *
 * @param {string} testDir - Absolute path to the project's test directory.
 * @param {Record<string, string | undefined>} env - Environment for the child.
 * @returns {Promise<void>} Resolves when mocha exits 0, rejects otherwise.
 */
async function runMochaSuite(
  testDir: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  const hasTsFiles = readdirSync(testDir).some((f) => f.endsWith(".ts"));
  const runnerArgs = hasTsFiles
    ? ["mocha", "-r", "ts-node/register", "test/**/*.ts"]
    : ["mocha", "test/**/*.js"];

  console.log(`\n========================================`);
  console.log(`Running tests with Mocha`);
  console.log(`========================================\n`);

  await run("npx", runnerArgs, { env, label: "test run" });
}

/**
 * Executes the automated smart contract test suite.
 * @param {object} options - CLI options.
 * @returns {Promise<void>} Resolves when tests complete.
 */
async function runTest(
  options: {
    gas?: boolean;
    verbose?: boolean;
    allowCors?: boolean;
    yes?: boolean;
  } = {},
): Promise<void> {
  // Before the compile: on a Node too old for EDR this run cannot finish, and
  // compiling first would spend the trust prompt and the build on nothing.
  requireEdrNode();

  const isVerbose = options.verbose;
  const allowCors = Boolean(options.allowCors);
  if (allowCors) {
    console.warn(
      `\x1b[33mwarning:\x1b[0m --allow-cors - the test RPC proxy on ${TEST_HOST}:` +
        `${TEST_PORT} accepts requests from any browser origin`,
    );
  }

  console.log("Compiling contracts...");
  // Compile failures keep reporting themselves as "compile failed" rather than
  // being relabelled by the command that triggered the compile.
  const { runCompile } = await import("./compile");
  await runCompile({ yes: options.yes }).catch(fail("compile", options));

  const testDir = path.resolve(process.cwd(), TEST_DIR_NAME);
  if (!existsSync(testDir)) {
    throw new Error(
      `test/ directory not found at ${testDir}.\n` +
        "\x1b[2mhint:\x1b[0m run `cmu test` from the root of your CointMU project.",
    );
  }

  silenceHardhatNoise({ verbose: isVerbose });

  console.log("Starting the CointMU DevNet...");

  const {
    hre,
    mnemonic: resolvedMnemonic,
    override,
  } = await bootHardhat({
    loggingEnabled: false,
  });

  // create(), not getOrCreate(): only create() applies a config override, and
  // without it the suite runs against Hardhat's stock accounts while
  // PRIVATE_KEY below is derived from a mnemonic nothing funded (issue #117).
  const connection = await hre.network.create({ override });
  const provider = connection.provider;

  const server = await startRpcProxy(provider, {
    port: TEST_PORT,
    host: TEST_HOST,
    allowCors,
    command: "cmu test",
  });

  try {
    const { ethers } = await import("ethers");
    const mnemonicObj = ethers.Mnemonic.fromPhrase(resolvedMnemonic);
    const wallet = ethers.HDNodeWallet.fromMnemonic(
      mnemonicObj,
      "m/44'/60'/0'/0/0",
    );
    const privateKey = wallet.privateKey;

    const injectedEnv = {
      ...process.env,
      CMU_RPC_URL: `http://127.0.0.1:${TEST_PORT}`,
      CMU_CHAIN_ID: String(LOCAL_CHAIN_ID),
      PRIVATE_KEY: privateKey,
    };

    await runMochaSuite(testDir, injectedEnv);

    console.log("\nAll tests passed.");
  } finally {
    if (options.gas) {
      await printGasReport(TEST_PORT, { verbose: isVerbose });
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    console.log("CointMU DevNet stopped.");
  }
}

export const testCommand = new Command("test")
  .description("Run the smart contract test suite")
  .option("--gas", "Report gas used by transactions during the run")
  .option(
    "--allow-cors",
    "Allow cross-origin browser access to the test RPC proxy; off by default to prevent DNS rebinding",
  )
  .option(
    "-y, --yes",
    "Skip the confirmation prompt before executing project code",
  )
  .action((options, command) => {
    // runTest reads verbose itself, to decide how much Hardhat noise to keep.
    const opts = command.optsWithGlobals();
    return runTest(opts).catch(fail("test", opts));
  });
