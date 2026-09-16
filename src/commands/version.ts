import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { Command } from "commander";
import { fail } from "../utils/errors";

const EXIT_FAILURE = 1;

// Inlined at bundle time by tsup (see tsup.config.ts `define`); undefined
// when running unbundled (e.g. ts-node in dev).
declare const __CMU_BUILD_ID__: string | undefined;

/**
 * Resolves the short Git commit hash of the current HEAD.
 * @returns {Promise<string>} The short commit hash, or "unknown".
 */
async function resolveGitCommit(): Promise<string> {
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
 * Prints detailed version information to the console.
 * @param {object} options - CLI options.
 * @returns {Promise<void>} Resolves when the version info is printed.
 */
export async function runVersion(
  options: { verbose?: boolean } = {},
): Promise<void> {
  const path = await import("path");

  const pkgPath = path.resolve(__dirname, "..", "package.json");

  let pkg = { version: "unknown", codename: "unknown" };

  if (existsSync(pkgPath)) {
    pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  }

  // Inlined by tsup at build time; undefined when running unbundled.
  const build =
    typeof __CMU_BUILD_ID__ !== "undefined" ? __CMU_BUILD_ID__ : "unknown";

  const solcRaw = await import("solc");
  const solc = solcRaw.default || solcRaw;
  const { ethers } = await import("ethers");
  const gitCommit = await resolveGitCommit();

  console.log("cmu");
  console.log(`version      : ${pkg.version}`);
  console.log(`codename     : ${pkg.codename}`);
  console.log(`build        : ${build}`);
  console.log(`architecture : ${process.arch}`);
  console.log(`node         : ${process.version}`);
  console.log(
    `solidity     : ${typeof solc.version === "function" ? solc.version() : "unknown"}`,
  );
  console.log(`ethers       : ${ethers.version}`);
  console.log(`git commit   : ${gitCommit}`);
}

export const versionCommand = new Command("version")
  .description("Show CLI, runtime and dependency versions")
  .option("-v, --verbose", "Print full stack traces on failure")
  .action((options) => runVersion(options).catch(fail("version", options)));
