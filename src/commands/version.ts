import { Command } from "commander";
import { printCliError } from "../utils/errors";

const EXIT_FAILURE = 1;

// Inlined at bundle time by tsup (see tsup.config.ts `define`); undefined
// when running unbundled (e.g. ts-node in dev).
declare const __CMU_BUILD_ID__: string | undefined;

/**
 * Resolves the short Git commit hash of the current HEAD.
 * @returns {Promise<string>} The short commit hash, or "unknown".
 */
export async function resolveGitCommit(): Promise<string> {
  try {
    const { execSync } = await import("child_process");
    return execSync("git rev-parse --short HEAD", {
      stdio: "pipe",
      cwd: __dirname,
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

/**
 * Reads the BUILD id straight out of the Makefile, used as a fallback
 * when build-info.json hasn't been generated yet (i.e. no build has run).
 * @param {string} makefilePath - Absolute path to the Makefile.
 * @returns {Promise<string>} The build id, or "unknown".
 */
export async function resolveMakefileBuild(
  makefilePath: string,
): Promise<string> {
  try {
    const fs = (await import("fs-extra")).default || (await import("fs-extra"));
    const content: string = await fs.readFile(makefilePath, "utf-8");
    const match = content.match(/^BUILD\s*=\s*(\S+)/m);
    return match ? match[1] : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Prints detailed version information to the console.
 * @param {object} options - CLI options.
 * @returns {Promise<void>} Resolves when the version info is printed.
 */
export async function runVersion(
  options: { verbose?: boolean } = {},
): Promise<void> {
  try {
    const fs = (await import("fs-extra")).default || (await import("fs-extra"));
    const path = await import("path");

    const pkgPath = path.resolve(__dirname, "..", "package.json");
    const buildPath = path.resolve(__dirname, "..", "build-info.json");
    const makefilePath = path.resolve(__dirname, "..", "Makefile");

    let pkg = { version: "unknown", codename: "unknown" };
    let buildInfo = { build: "unknown" };

    if (await fs.pathExists(pkgPath)) {
      pkg = await fs.readJson(pkgPath);
    }

    if (
      typeof __CMU_BUILD_ID__ !== "undefined" &&
      __CMU_BUILD_ID__ !== "unknown"
    ) {
      buildInfo.build = __CMU_BUILD_ID__;
    } else if (await fs.pathExists(buildPath)) {
      buildInfo = await fs.readJson(buildPath);
    } else {
      buildInfo.build = await resolveMakefileBuild(makefilePath);
    }

    const solcRaw = await import("solc");
    const solc = solcRaw.default || solcRaw;
    const { ethers } = await import("ethers");
    const gitCommit = await resolveGitCommit();

    console.log("cmu");
    console.log(`version      : ${pkg.version}`);
    console.log(`codename     : ${pkg.codename}`);
    console.log(`build        : ${buildInfo.build}`);
    console.log(`architecture : ${process.arch}`);
    console.log(`node         : ${process.version}`);
    console.log(
      `solidity     : ${typeof solc.version === "function" ? solc.version() : "unknown"}`,
    );
    console.log(`ethers       : ${ethers.version}`);
    console.log(`git commit   : ${gitCommit}`);
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m version failed");
    printCliError(error, options.verbose);
    process.exit(EXIT_FAILURE);
  }
}

export const versionCommand = new Command("version")
  .description("Show CLI, runtime and dependency versions")
  .option("-v, --verbose", "Print full stack traces on failure")
  .action(runVersion);
