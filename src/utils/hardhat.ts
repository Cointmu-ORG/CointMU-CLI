/**
 * Shared bootstrap for the two commands that drive Hardhat in-process,
 * `cmu test` and `cmu node start`. Both suppress the same dependency noise and
 * configure the same devnet accounts; the differences are parameterised here.
 */

import { LOCAL_CHAIN_ID } from "./defaults";
/** Number of pre-funded accounts the devnet derives from its mnemonic. */
export const ACCOUNT_COUNT = 10;
/** Starting balance of each pre-funded account, in wei (100 ETH). */
export const ACCOUNT_BALANCE = "100000000000000000000";

/**
 * Warnings emitted by Hardhat's transitive dependencies that say nothing a user
 * of this CLI can act on. Matched as substrings against the joined arguments.
 */
const NOISE_PATTERNS = [
  "uws_win32",
  "Falling back to a NodeJS implementation",
  "This version of",
  "uws-js-unofficial",
];

/**
 * Substrings that appear in the µWS fallback chatter but also in every genuine
 * module-resolution failure. Matching them outright hid real errors - a project
 * missing `ethers` reported nothing at all - so they only count as noise when
 * the same message is recognisably about µWS.
 */
const UWS_ONLY_PATTERNS = ["Require stack:", "Cannot find module"];

/**
 * Reports whether a message is about the µWS optional binary.
 * Plain substring checks rather than a case-insensitive regex: the name is
 * spelled with U+00B5 MICRO SIGN, which does not case-fold to "m" reliably.
 *
 * @param {string} message - The joined console arguments.
 * @returns {boolean} True when the message mentions µWS.
 */
function mentionsUws(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("uws") || lower.includes("µws");
}

/** The console functions as they were before silenceHardhatNoise() patched them. */
export interface ConsoleHandle {
  log: typeof console.log;
  warn: typeof console.warn;
  error: typeof console.error;
  /** Puts the original console functions back. */
  restore(): void;
}

/**
 * Filters dependency noise out of console.error/warn/log for the rest of the
 * process, and hands back the unpatched functions so a caller can still print
 * its own output.
 *
 * @param {object} [options]
 * @param {boolean} [options.verbose] - Let everything through.
 * @param {string[]} [options.extraPatterns] - Additional substrings to swallow.
 * @param {Function} [options.onLog] - Inspects each console.log line before the
 *   noise filter forwards it. Return true when the line has been handled and
 *   should not be printed again.
 * @returns {ConsoleHandle} The original console functions, plus restore().
 */
export function silenceHardhatNoise(
  options: {
    verbose?: boolean;
    extraPatterns?: string[];
    onLog?: (
      message: string,
      args: any[],
      originalLog: typeof console.log,
    ) => boolean;
  } = {},
): ConsoleHandle {
  const patterns = [...NOISE_PATTERNS, ...(options.extraPatterns ?? [])];

  const isNoise = (args: any[]) => {
    if (options.verbose) return false;
    const message = args.join(" ");
    if (patterns.some((pattern) => message.includes(pattern))) return true;
    return (
      mentionsUws(message) &&
      UWS_ONLY_PATTERNS.some((pattern) => message.includes(pattern))
    );
  };

  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  console.error = (...args: any[]) => {
    if (isNoise(args)) return;
    original.error(...args);
  };

  console.warn = (...args: any[]) => {
    if (isNoise(args)) return;
    original.warn(...args);
  };

  console.log = (...args: any[]) => {
    if (isNoise(args)) return;
    if (options.onLog?.(args.join(" "), args, original.log)) return;
    original.log(...args);
  };

  return {
    ...original,
    restore() {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    },
  };
}

/**
 * The CointMU devnet as a Hardhat network override, with the mnemonic its
 * accounts are derived from. Callers apply it with
 * `hre.network.create({ override })`.
 *
 * An override rather than a config edit, because `hre.config` is the *resolved*
 * config: it is keyed by the networks Hardhat 3 actually ships (`default`,
 * `node`, `localhost` - there is no `hardhat` network), and its accounts hold
 * ConfigurationVariables rather than plain strings. Writing the devnet settings
 * onto it therefore configured nothing, and the served chain kept Hardhat's
 * stock chain ID and publicly known test accounts while the CLI printed keys
 * derived from a mnemonic that funded nothing (issue #117).
 * `hre.network.create()` merges an override back into the *user* config and
 * re-resolves it, which is the supported way in.
 *
 * @param {object} options
 * @param {string} [options.mnemonic] - Mnemonic for the pre-funded accounts.
 *   A fresh random one is generated when omitted.
 * @param {boolean} options.loggingEnabled - Hardhat's own request logging.
 * @returns {Promise<{mnemonic: string, override: any}>} The mnemonic and the
 *   network override to connect with.
 * @throws {Error} When no mnemonic could be generated.
 */
export async function devnetOverride(options: {
  mnemonic?: string;
  loggingEnabled: boolean;
}): Promise<{ mnemonic: string; override: any }> {
  const { ethers } = await import("ethers");
  const mnemonic =
    options.mnemonic || ethers.Wallet.createRandom().mnemonic?.phrase || "";

  // Checked here rather than in the callers: an empty mnemonic reaches Hardhat
  // as a config validation error, which says nothing about what to do next.
  if (!mnemonic) {
    throw new Error(
      "could not generate a mnemonic for the devnet accounts.\n" +
        "\x1b[2mhint:\x1b[0m this usually means the crypto module is unavailable; check your Node.js install.",
    );
  }

  return {
    mnemonic,
    override: {
      chainId: LOCAL_CHAIN_ID,
      loggingEnabled: options.loggingEnabled,
      accounts: {
        mnemonic,
        accountsBalance: ACCOUNT_BALANCE,
        count: ACCOUNT_COUNT,
      },
    },
  };
}

/**
 * Loads Hardhat and hands back the devnet override to connect it with.
 *
 * Hardhat 3 is ESM-only, so it is reached through a `new Function` indirection:
 * tsup emits CJS, where a literal `import()` would be downleveled to require().
 * That indirection is why devnetOverride() is separate - it is the half that
 * can be exercised outside a real CLI run.
 *
 * @param {object} options - See devnetOverride().
 * @returns {Promise<{hre: any, mnemonic: string, override: any}>} The runtime,
 *   plus everything devnetOverride() returns.
 */
export async function bootHardhat(options: {
  mnemonic?: string;
  loggingEnabled: boolean;
}): Promise<{ hre: any; mnemonic: string; override: any }> {
  const { mnemonic, override } = await devnetOverride(options);

  const importDynamic = new Function("modulePath", "return import(modulePath)");
  const hre =
    (await importDynamic("hardhat")).default ||
    (await importDynamic("hardhat"));

  return { hre, mnemonic, override };
}
