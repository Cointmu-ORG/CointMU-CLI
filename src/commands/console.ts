import { existsSync, readFileSync } from "fs";
import { Command } from "commander";
import { fail } from "../utils/errors";
import { confirmProjectTrust, findProjectConfig } from "../utils/trust";

/** Shown in place of an address when the console starts without a signer. */
const NO_SIGNER_LABEL = "none (read-only) - run `cmu wallet login`";

interface ConsoleOptions {
  network?: string;
  /** Commander sets this to false for --no-signer; it defaults to true. */
  signer?: boolean;
  verbose?: boolean;
  yes?: boolean;
}

/**
 * Resolves everything the REPL needs before it opens: the network, a provider
 * and, when a key is available, a signer connected to that provider.
 *
 * A missing key is not an error. The common reason to open a console is to
 * read - "what is totalSupply right now" - so `signer` is simply left
 * undefined and the REPL still starts, the same way `hardhat console` and
 * `truffle console` always hand you a provider and only sometimes a signer.
 *
 * Does no network I/O of its own: constructing a provider dials nothing, which
 * keeps this half of the command testable without a node or a fake ethers.
 *
 * @param {ConsoleOptions} [options] - CLI options.
 * @returns {Promise<{ network: object, provider: object, signer: object | undefined }>}
 *   The resolved network configuration, provider and optional signer.
 * @throws {Error} When the project is not trusted, the network cannot be
 *   resolved, or a key is present but unusable.
 */
export async function resolveConsoleContext(options: ConsoleOptions = {}) {
  // getDeployNetwork() require()s cmu.config.ts, which is arbitrary project
  // code, so gate it the same way `cmu compile` does. Only the config file is
  // listed: unlike deploy, the console never executes deploy/.
  const configPath = findProjectConfig();
  await confirmProjectTrust(configPath ? [configPath] : [], {
    yes: options.yes,
  });

  const { getDeployNetwork } = await import("../utils/network");
  // --no-signer skips the session password prompt entirely, so a read-only
  // console can open in a project whose .cmu-session is locked.
  const network = await getDeployNetwork(options.network, {
    noPrompt: options.signer === false,
  });

  const { ethers } = await import("ethers");
  // staticNetwork: detect the chain once and then pin it, so every call typed
  // at the prompt is one request instead of two. Pinning the configured
  // chainId instead would let a wrong config sign for the wrong chain.
  const provider = new ethers.JsonRpcProvider(network.url, undefined, {
    staticNetwork: true,
  });

  let signer;
  if (options.signer !== false && network.privateKey) {
    try {
      signer = new ethers.Wallet(network.privateKey, provider);
    } catch {
      throw new Error(
        "invalid private key.\n" +
          "\x1b[2mhint:\x1b[0m expected a 32-byte hex key (0x-prefixed); run `cmu console --no-signer` to start read-only.",
      );
    }
  }

  return { network, provider, signer };
}

/**
 * Builds the REPL's `getContract(name, address)` over a provider and, when
 * there is one, a signer.
 *
 * The address is required. Nothing in a project records deployed addresses per
 * network: deployments/<Contract>.json is written by the scaffolded deploy
 * script, is one file per contract rather than per chain, and is absent
 * entirely for a hand-written script - so resolving an address from it would
 * silently point the console at a contract on the wrong chain. Per-network
 * deployment tracking is tracked separately.
 *
 * Synchronous on purpose: it reads one local file, and returning the contract
 * rather than a promise keeps `getContract("Token", "0x...").totalSupply()`
 * from needing two awaits at the prompt.
 *
 * @param {object} ctx - The REPL's provider and optional signer.
 * @returns {(name: string, address: string) => object} The bound helper.
 */
export function makeGetContract(ctx: { provider: any; signer?: any }) {
  const { ethers } = require("ethers");
  const path = require("path");

  return function getContract(name: string, address: string) {
    if (!address) {
      throw new Error(
        "getContract(name, address) requires an address.\n" +
          '\x1b[2mhint:\x1b[0m getContract("Token", "0x...") - the console does not look addresses up.',
      );
    }
    // ethers treats a non-address string as a possible ENS name and resolves it
    // asynchronously, so without this the mistake surfaces as a connection
    // error from somewhere else entirely.
    if (!ethers.isAddress(address)) {
      throw new Error(
        `'${address}' is not a valid contract address.\n` +
          "\x1b[2mhint:\x1b[0m expected a 0x-prefixed 20-byte address.",
      );
    }

    const artifactPath = path.resolve(
      process.cwd(),
      "artifacts",
      `${name}.json`,
    );
    if (!existsSync(artifactPath)) {
      throw new Error(
        `artifact for '${name}' not found at artifacts/${name}.json.\n` +
          "\x1b[2mhint:\x1b[0m run `cmu compile` first; the name is the contract name, not the .sol file name.",
      );
    }

    let abi;
    try {
      abi = JSON.parse(readFileSync(artifactPath, "utf8")).abi;
    } catch {
      // Unreadable JSON and a missing abi have the same fix, so they share the
      // message below.
    }
    if (!Array.isArray(abi)) {
      throw new Error(
        `artifacts/${name}.json is not a usable artifact (no abi).\n` +
          "\x1b[2mhint:\x1b[0m delete it and run `cmu compile` again.",
      );
    }

    return new ethers.Contract(address, abi, ctx.signer ?? ctx.provider);
  };
}

/**
 * Opens the interactive console.
 *
 * Returns the exit code rather than calling process.exit() itself, following
 * runDeploy(); the single exit lives in the command handler below.
 *
 * @param {ConsoleOptions} options - CLI options.
 * @returns {Promise<number>} The process exit code, once the REPL is closed.
 */
export async function runConsole(
  options: ConsoleOptions = {},
): Promise<number> {
  const { network, provider, signer } = await resolveConsoleContext(options);

  // Fail here, with the endpoint named, rather than opening a REPL in which
  // every call the user types errors out.
  const { pingNetwork } = await import("./deploy");
  await pingNetwork(network.url);

  console.log(`\n--- Console configuration ---`);
  console.log(`Network      : ${network.name}`);
  console.log(`RPC endpoint : ${network.url}`);
  console.log(`Chain ID     : ${network.chainId}`);
  console.log(`Signer       : ${signer ? signer.address : NO_SIGNER_LABEL}`);
  console.log(
    `Preloaded    : provider, signer, ethers, getContract(name, address)`,
  );
  console.log(`-----------------------------\n`);

  const repl = await import("node:repl");
  const { ethers } = await import("ethers");

  // useGlobal: the REPL would otherwise evaluate in its own vm realm, where a
  // Uint8Array typed at the prompt fails ethers' `instanceof Uint8Array`
  // checks and every bytes-taking call rejects it as an invalid BytesLike.
  // The default eval already supports top-level await, so there is no custom
  // eval here - and breakEvalOnSigint could not be set alongside one anyway.
  const server = repl.start({
    prompt: "cmu> ",
    useGlobal: true,
    breakEvalOnSigint: true,
  });
  Object.assign(server.context, {
    provider,
    signer,
    ethers,
    getContract: makeGetContract({ provider, signer }),
  });

  // The REPL owns stdin and SIGINT from here: Ctrl+C interrupts the running
  // eval, and .exit / Ctrl+D end the session. A SIGINT handler of our own
  // would kill the process on the first Ctrl+C instead.
  await new Promise<void>((resolve) => server.on("exit", () => resolve()));
  provider.destroy();
  return 0;
}

export const consoleCommand = new Command("console")
  .description("Open an interactive REPL against the configured network")
  .option("-n, --network <name>", "Network to connect to")
  .option(
    "--no-signer",
    "Start read-only: skip signer resolution and the session password prompt",
  )
  .option(
    "-y, --yes",
    "Skip the confirmation prompt before executing project code",
  )
  .addHelpText(
    "after",
    "\ncmu.config.ts/js is executed as code from the project directory, and the\n" +
      "REPL then runs whatever you type with your full environment, including any\n" +
      "key it decrypted. Only open a console in projects you trust; see the\n" +
      "'Trust Model' section of the README.",
  )
  .action((options: ConsoleOptions, command) => {
    // No blanket hint here: the console can fail on the config, the network,
    // the endpoint or the wallet session, and each of those errors already
    // carries the hint that fits it.
    const opts = command.optsWithGlobals() as ConsoleOptions;
    return runConsole(opts).then(process.exit, fail("console", opts));
  });
