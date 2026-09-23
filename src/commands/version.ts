import { Command } from "commander";
import { fail } from "../utils/errors";
import { readPkg } from "../utils/pkg";

// Inlined at bundle time by tsup (see tsup.config.ts `define`); undefined
// when running unbundled (e.g. ts-node in dev).
declare const __CMU_BUILD_ID__: string | undefined;

/**
 * Prints detailed version information to the console.
 * @returns {Promise<void>} Resolves when the version info is printed.
 */
export async function runVersion(): Promise<void> {
  const pkg = readPkg();

  // Inlined by tsup at build time; undefined when running unbundled.
  const build =
    typeof __CMU_BUILD_ID__ !== "undefined" ? __CMU_BUILD_ID__ : "unknown";

  const solcRaw = await import("solc");
  const solc = solcRaw.default || solcRaw;
  const { ethers } = await import("ethers");

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
}

export const versionCommand = new Command("version")
  .description("Show CLI, runtime and dependency versions")
  .action((options, command) =>
    runVersion().catch(fail("version", command.optsWithGlobals())),
  );
