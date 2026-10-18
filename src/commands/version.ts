import { existsSync, readFileSync } from "fs";
import * as path from "path";
import { Command } from "commander";
import { fail } from "../utils/errors";
import { readPkg } from "../utils/pkg";

// Inlined at bundle time by tsup (see tsup.config.ts `define`); undefined
// when running unbundled (e.g. ts-node in dev).
declare const __CMU_BUILD_ID__: string | undefined;
// The solc and ethers versions the bundle was built against. Loading solc just
// to ask it costs ~0.6 s (soljson), and its full version string exists only
// inside the wasm, so the build asks once. `pkg` is solc's package.json version,
// which is what the installed copy is compared against.
declare const __CMU_SOLC_VERSION__: { pkg: string; full: string } | undefined;
declare const __CMU_ETHERS_VERSION__: string | undefined;

/**
 * The `version` of a package.json, when it belongs to the named package.
 * @param {string} file - Path to a package.json.
 * @param {string} name - The package it has to belong to.
 * @returns {string | undefined} The version, or undefined for any other file.
 */
function readPackageVersion(file: string, name: string): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const json = JSON.parse(readFileSync(file, "utf8"));
    return json.name === name ? json.version : undefined;
  } catch {
    // Unreadable is "unknown": the caller then loads the module itself, which
    // reports a broken install the way it always has.
    return undefined;
  }
}

/**
 * The version of a dependency as installed, read from its package.json.
 *
 * Found by walking up from the resolved entry point: ethers does not export
 * `./package.json`, and its lib.commonjs/ has a package.json of its own with
 * no name or version.
 *
 * @param {string} name - The dependency.
 * @returns {string | undefined} Its version, or undefined when it cannot be read.
 */
function installedVersion(name: string): string | undefined {
  let dir: string;
  try {
    dir = path.dirname(require.resolve(name));
  } catch {
    // Not resolvable: loading the module reports why.
    return undefined;
  }
  while (dir !== path.dirname(dir)) {
    const version = readPackageVersion(path.join(dir, "package.json"), name);
    if (version) return version;
    dir = path.dirname(dir);
  }
  return undefined;
}

/**
 * solc's version string, from the build when the installed solc is the one the
 * build saw, otherwise from solc itself.
 * @returns {Promise<string>} The full solc version.
 */
async function solidityVersion(): Promise<string> {
  if (
    typeof __CMU_SOLC_VERSION__ !== "undefined" &&
    installedVersion("solc") === __CMU_SOLC_VERSION__.pkg
  ) {
    return __CMU_SOLC_VERSION__.full;
  }
  const solcRaw = await import("solc");
  const solc = solcRaw.default || solcRaw;
  return typeof solc.version === "function" ? solc.version() : "unknown";
}

/**
 * ethers' version, from the build when the installed ethers is the one the
 * build saw, otherwise from ethers itself.
 * @returns {Promise<string>} The ethers version.
 */
async function ethersVersion(): Promise<string> {
  if (
    typeof __CMU_ETHERS_VERSION__ !== "undefined" &&
    installedVersion("ethers") === __CMU_ETHERS_VERSION__
  ) {
    return __CMU_ETHERS_VERSION__;
  }
  const { ethers } = await import("ethers");
  return ethers.version;
}

/**
 * Prints detailed version information to the console.
 * @returns {Promise<void>} Resolves when the version info is printed.
 */
export async function runVersion(): Promise<void> {
  const pkg = readPkg();

  // Inlined by tsup at build time; undefined when running unbundled.
  const build =
    typeof __CMU_BUILD_ID__ !== "undefined" ? __CMU_BUILD_ID__ : "unknown";

  const solidity = await solidityVersion();
  const ethers = await ethersVersion();

  console.log("cmu");
  console.log(`version      : ${pkg.version}`);
  console.log(`codename     : ${pkg.codename}`);
  console.log(`build        : ${build}`);
  console.log(`architecture : ${process.arch}`);
  console.log(`node         : ${process.version}`);
  console.log(`solidity     : ${solidity}`);
  console.log(`ethers       : ${ethers}`);
}

export const versionCommand = new Command("version")
  .description("Show CLI, runtime and dependency versions")
  .action((options, command) =>
    runVersion().catch(fail("version", command.optsWithGlobals())),
  );
