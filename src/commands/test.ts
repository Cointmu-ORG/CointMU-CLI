import { Command } from "commander";

const EXIT_FAILURE = 1;
const TEST_PORT = 8555;
const DEFAULT_CHAIN_ID = 1912;
const ACCOUNT_COUNT = 10;
const ACCOUNT_BALANCE = "100000000000000000000";
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
      "\x1b[33m[!] --allow-cors: the test RPC proxy on 127.0.0.1:" +
        `${TEST_PORT} now accepts requests from any browser origin.\x1b[0m`,
    );
  }
  try {
    const fs = (await import("fs-extra")).default || (await import("fs-extra"));
    const path = await import("path");

    console.log("Triggering automated contract compilation...");
    const { runCompile } = await import("./compile");
    await runCompile({ yes: options.yes });

    const testDir = path.resolve(process.cwd(), TEST_DIR_NAME);
    if (!(await fs.pathExists(testDir))) {
      throw new Error(`'test' directory not found at ${testDir}.`);
    }

    const suppressWarning = (args: any[]) => {
      if (isVerbose) return false;
      const msg = args.join(" ");
      return (
        msg.includes("uws_win32") ||
        msg.includes("Falling back to a NodeJS implementation") ||
        msg.includes("This version of \u00B5WS") ||
        msg.includes("This version of") ||
        msg.includes("uws-js-unofficial") ||
        msg.includes("Require stack:") ||
        msg.includes("Cannot find module")
      );
    };

    const originalConsoleError = console.error;
    console.error = (...args: any[]) => {
      if (suppressWarning(args)) return;
      originalConsoleError(...args);
    };

    const originalConsoleWarn = console.warn;
    console.warn = (...args: any[]) => {
      if (suppressWarning(args)) return;
      originalConsoleWarn(...args);
    };

    const originalConsoleLog = console.log;
    console.log = (...args: any[]) => {
      if (suppressWarning(args)) return;
      originalConsoleLog(...args);
    };

    console.log("Starting ephemeral CointMU DevNet for testing...");

    const importDynamic = new Function(
      "modulePath",
      "return import(modulePath)",
    );
    const hre =
      (await importDynamic("hardhat")).default ||
      (await importDynamic("hardhat"));
    const { ethers } = require("ethers");
    const resolvedMnemonic =
      ethers.Wallet.createRandom().mnemonic?.phrase || "";

    if (!hre.config.networks) hre.config.networks = {};
    if (!hre.config.networks.hardhat)
      hre.config.networks.hardhat = { type: "hardhat" } as any;

    hre.config.networks.hardhat.chainId = DEFAULT_CHAIN_ID;
    hre.config.networks.hardhat.accounts = {
      mnemonic: resolvedMnemonic,
      accountsBalance: ACCOUNT_BALANCE,
      count: ACCOUNT_COUNT,
    };
    hre.config.networks.hardhat.loggingEnabled = false;

    const connection = await hre.network.getOrCreate();
    const provider = connection.provider;

    const http = require("http");

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
            `{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Forbidden: cross-origin or non-local request rejected. Pass --allow-cors to cmu test for browser access."}}`,
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

    try {
      if (!resolvedMnemonic) {
        throw new Error("Failed to generate mnemonic for test accounts.");
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
        CMU_CHAIN_ID: String(DEFAULT_CHAIN_ID),
        PRIVATE_KEY: privateKey,
      };

      const isWin = process.platform === "win32";

      // Check if there are JS or TS files in the test directory
      const hasTsFiles = fs
        .readdirSync(testDir)
        .some((f: string) => f.endsWith(".ts"));
      const runnerArgs = hasTsFiles
        ? ["mocha", "-r", "ts-node/register", "test/**/*.ts"]
        : ["mocha", "test/**/*.js"];

      console.log(`\n========================================`);
      console.log(`Running tests via Mocha`);
      console.log(`========================================\n`);

      const { spawn } = require("child_process");
      await new Promise<void>((resolve, reject) => {
        const child = spawn("npx", runnerArgs, {
          stdio: "inherit",
          env: injectedEnv,
          shell: isWin,
        });
        child.on("close", (code: number) => {
          if (code === 0) resolve();
          else reject(new Error(`Test command failed with exit code ${code}`));
        });
        child.on("error", (err: Error) => reject(err));
      });

      console.log("\nAll tests executed successfully.");
    } finally {
      if (options.gas) {
        try {
          console.log(
            "\n=========================================================================================",
          );
          console.log("Gas Profiler Report");
          console.log(
            "=========================================================================================",
          );
          console.log(
            "| Block | Transaction Hash                                                   | Gas Used |",
          );
          console.log(
            "-----------------------------------------------------------------------------------------",
          );

          const { ethers } = require("ethers");
          const rpcProvider = new ethers.JsonRpcProvider(
            `http://127.0.0.1:${TEST_PORT}`,
          );
          const latestBlock = await rpcProvider.getBlockNumber();
          let totalGas = 0n;

          for (let i = 1; i <= latestBlock; i++) {
            const block = await rpcProvider.getBlock(i);
            if (block && block.transactions) {
              for (const txHash of block.transactions) {
                const receipt = await rpcProvider.getTransactionReceipt(txHash);
                if (receipt) {
                  const gasUsed = receipt.gasUsed;
                  totalGas += gasUsed;
                  console.log(
                    `| ${i.toString().padEnd(5)} | ${txHash} | ${gasUsed.toString().padEnd(8)} |`,
                  );
                }
              }
            }
          }
          console.log(
            "-----------------------------------------------------------------------------------------",
          );
          console.log(`Total Gas Used: ${totalGas.toString()}\n`);
        } catch (e) {
          console.error("Failed to generate gas report");
          if (isVerbose) {
            console.error(e);
          }
        }
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      console.log("Ephemeral test network successfully shut down.");
    }
  } catch (error) {
    console.error("\n\x1b[31m[!] Test suite failed:\x1b[0m");
    if (isVerbose) {
      console.error(error);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(EXIT_FAILURE);
  }
}

export const testCommand = new Command("test")
  .description("Executes the automated smart contract test suite")
  .option(
    "--gas",
    "Enable gas profiler to report gas used by transactions during tests",
  )
  .option("-v, --verbose", "Enable verbose logging for debugging")
  .option(
    "--allow-cors",
    "Allow browser (cross-origin) access to the local test RPC proxy; off by default to prevent DNS-rebinding attacks",
  )
  .option(
    "-y, --yes",
    "Skip the confirmation prompt before executing project code",
  )
  .action(runTest);
