import { existsSync, readdirSync } from "fs";
import { Command } from "commander";
import { printCliError } from "../utils/errors";
import { bootHardhat, silenceHardhatNoise } from "../utils/hardhat";
import { LOCAL_CHAIN_ID } from "../utils/defaults";

const EXIT_FAILURE = 1;
const TEST_PORT = 8555;
const TEST_DIR_NAME = "test";

const RPC_ALLOWED_HOSTS = new Set([
  `127.0.0.1:${TEST_PORT}`,
  `localhost:${TEST_PORT}`,
  `[::1]:${TEST_PORT}`,
]);

/**
 * Guards the local test RPC proxy against browser-originated access
 * (DNS rebinding against a localhost JSON-RPC server, issue #83).
 *
 * Node JSON-RPC clients (ethers JsonRpcProvider, the spawned mocha process)
 * send no `Origin` header and always address the loopback `Host`. A browser
 * always sends `Origin` on a cross-origin fetch, and a DNS-rebound request
 * carries an attacker-controlled `Host`. Either one is rejected unless the
 * user explicitly opts in with `--allow-cors`.
 *
 * @param {object} headers - Incoming request headers (`req.headers`).
 * @param {boolean} [allowCors] - True when `--allow-cors` was passed.
 * @returns {boolean} True when the request may be proxied to the provider.
 */
export function isRpcRequestAllowed(
  headers: {
    origin?: string | string[];
    host?: string | string[];
  },
  allowCors = false,
): boolean {
  if (allowCors) return true;

  const origin = Array.isArray(headers.origin)
    ? headers.origin[0]
    : headers.origin;
  if (origin != null && origin !== "") return false;

  const host = Array.isArray(headers.host) ? headers.host[0] : headers.host;
  if (
    host != null &&
    host !== "" &&
    !RPC_ALLOWED_HOSTS.has(host.toLowerCase())
  ) {
    return false;
  }

  return true;
}

/**
 * Minimal surface this proxy needs from a provider: Hardhat's EIP-1193 request
 * method. Narrowed so the proxy can be tested without a Hardhat runtime.
 */
export interface RpcProvider {
  request(payload: { method: string; params: unknown[] }): Promise<unknown>;
}

/**
 * Serves the in-process Hardhat network over HTTP so the spawned mocha run, and
 * anything else speaking JSON-RPC, can reach it on loopback.
 *
 * Every request passes isRpcRequestAllowed() first; see its notes for why a
 * browser-reachable localhost JSON-RPC server needs a gate at all (issue #83).
 * Batched requests are answered element by element, and a provider error is
 * reported per element rather than failing the whole batch.
 *
 * Always binds TEST_PORT: isRpcRequestAllowed()'s Host allowlist is built from
 * that same port, so a proxy on any other port would reject every request.
 *
 * @param {RpcProvider} provider - The provider to forward calls to.
 * @param {object} [options]
 * @param {boolean} [options.allowCors] - Serve browser origins (`--allow-cors`).
 * @returns {Promise<any>} The listening http.Server.
 */
export async function startRpcProxy(
  provider: RpcProvider,
  options: { allowCors?: boolean } = {},
): Promise<any> {
  const http = require("http");
  const allowCors = Boolean(options.allowCors);

  const server = http.createServer((req: any, res: any) => {
    let body = "";
    req.on("data", (chunk: any) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      if (!isRpcRequestAllowed(req.headers, allowCors)) {
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json");
        return res.end(
          `{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Forbidden: cross-origin or non-local request rejected. Pass --allow-cors to cmu test to allow browser access."}}`,
        );
      }
      if (req.method === "OPTIONS") {
        if (allowCors) {
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Access-Control-Allow-Headers", "*");
          res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
          res.statusCode = 204;
        } else {
          res.statusCode = 403;
        }
        return res.end();
      }
      if (!body) {
        res.statusCode = 400;
        return res.end();
      }
      try {
        const json = JSON.parse(body);
        const isArray = Array.isArray(json);
        const reqs = isArray ? json : [json];
        const responses = [];

        for (const r of reqs) {
          try {
            const result = await provider.request({
              method: r.method,
              params: r.params || [],
            });
            responses.push({ jsonrpc: "2.0", id: r.id, result });
          } catch (error: any) {
            responses.push({
              jsonrpc: "2.0",
              id: r.id,
              error: { code: error.code || -32603, message: error.message },
            });
          }
        }

        res.setHeader("Content-Type", "application/json");
        if (allowCors) res.setHeader("Access-Control-Allow-Origin", "*");
        res.end(JSON.stringify(isArray ? responses : responses[0]));
      } catch {
        res.statusCode = 400;
        res.end(
          `{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}`,
        );
      }
    });
  });

  const { killPort } = await import("../utils/process");
  await killPort(TEST_PORT);

  await new Promise<void>((resolve, reject) => {
    server.listen(TEST_PORT, "127.0.0.1", (err?: Error) => {
      if (err) return reject(err);
      resolve();
    });
  });

  return server;
}

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

  const { spawn } = require("child_process");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", runnerArgs, {
      stdio: "inherit",
      env,
      shell: process.platform === "win32",
    });
    child.on("close", (code: number) => {
      if (code === 0) resolve();
      else reject(new Error(`test run exited with code ${code}`));
    });
    child.on("error", (err: Error) => reject(err));
  });
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
  const isVerbose = options.verbose;
  const allowCors = Boolean(options.allowCors);
  if (allowCors) {
    console.warn(
      "\x1b[33mwarning:\x1b[0m --allow-cors - the test RPC proxy on 127.0.0.1:" +
        `${TEST_PORT} accepts requests from any browser origin`,
    );
  }
  try {
    const path = await import("path");

    console.log("Compiling contracts...");
    const { runCompile } = await import("./compile");
    await runCompile({ yes: options.yes });

    const testDir = path.resolve(process.cwd(), TEST_DIR_NAME);
    if (!existsSync(testDir)) {
      throw new Error(
        `test/ directory not found at ${testDir}.\n` +
          "\x1b[2mhint:\x1b[0m run `cmu test` from the root of your CointMU project.",
      );
    }

    silenceHardhatNoise({ verbose: isVerbose });

    console.log("Starting the CointMU DevNet...");

    const { hre, mnemonic: resolvedMnemonic } = await bootHardhat({
      loggingEnabled: false,
    });

    const connection = await hre.network.getOrCreate();
    const provider = connection.provider;

    const server = await startRpcProxy(provider, { allowCors });

    try {
      const { ethers } = await import("ethers");
      if (!resolvedMnemonic) {
        throw new Error(
          "could not generate a mnemonic for the test accounts.\n" +
            "\x1b[2mhint:\x1b[0m this usually means the crypto module is unavailable; check your Node.js install.",
        );
      }

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
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m test failed");
    printCliError(error, isVerbose);
    process.exit(EXIT_FAILURE);
  }
}

export const testCommand = new Command("test")
  .description("Run the smart contract test suite")
  .option("--gas", "Report gas used by transactions during the run")
  .option("-v, --verbose", "Print full stack traces on failure")
  .option(
    "--allow-cors",
    "Allow cross-origin browser access to the test RPC proxy; off by default to prevent DNS rebinding",
  )
  .option(
    "-y, --yes",
    "Skip the confirmation prompt before executing project code",
  )
  .action(runTest);
