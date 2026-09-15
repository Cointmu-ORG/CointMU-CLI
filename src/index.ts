#!/usr/bin/env node

// Must stay the first import: imports are hoisted, so anything below this line
// (commander included) loads before a version check placed further down runs.
import "./preflight";

import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";

const CLI_NAME = "cmu";
const EXIT_FAILURE = 1;
const PKG_ENCODING = "utf8";
const HARDHAT_CONFIG_ENV = "HARDHAT_CONFIG";
const HARDHAT_CONFIG_PATH = "../hardhat.config.js";
const DOTENV_QUIET = true;
const PKG_FILE = "package.json";
const FLAG_VERSION_SHORT = "-V";
const FLAG_VERSION_LONG = "--version";
const FLAG_HELP_SHORT = "-h";
const FLAG_HELP_LONG = "--help";

require("dotenv").config({ quiet: DOTENV_QUIET });
process.env[HARDHAT_CONFIG_ENV] = path.resolve(__dirname, HARDHAT_CONFIG_PATH);

const pkgPath = path.resolve(__dirname, "..", PKG_FILE);
const pkg = JSON.parse(fs.readFileSync(pkgPath, PKG_ENCODING));

const program = new Command();

program
  .name(CLI_NAME)
  .description(
    `${pkg.description}\nTip: Run ${CLI_NAME} <command> ${FLAG_HELP_SHORT} to see detailed options for a specific command.`,
  );

/**
 * Loads the requested command module, or all modules if help is requested.
 * Registers them on the program, then parses process arguments asynchronously.
 * @returns {Promise<void>} Resolves when all required commands are registered and arguments are parsed.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmdStr = args[0];

  if (
    args.length === 1 &&
    (cmdStr === FLAG_VERSION_SHORT || cmdStr === FLAG_VERSION_LONG)
  ) {
    const { runVersion } = await import("./commands/version");
    await runVersion();
    return;
  }

  const commandMap: Record<string, () => Promise<void>> = {
    compile: async () => {
      const m = await import("./commands/compile");
      program.addCommand(m.compileCommand);
    },
    deploy: async () => {
      const m = await import("./commands/deploy");
      program.addCommand(m.deployCommand);
    },
    wallet: async () => {
      const m = await import("./commands/wallet");
      program.addCommand(m.walletCommand);
    },
    create: async () => {
      const m = await import("./commands/create");
      program.addCommand(m.createCommand);
    },
    explorer: async () => {
      const m = await import("./commands/explorer");
      program.addCommand(m.explorerCommand);
    },
    node: async () => {
      const m = await import("./commands/node");
      program.addCommand(m.nodeCommand);
    },
    audit: async () => {
      const m = await import("./commands/audit");
      program.addCommand(m.auditCommand);
    },
    aries: async () => {
      const m = await import("./commands/aries");
      program.addCommand(m.ariesCommand, { hidden: true });
    },
    version: async () => {
      const m = await import("./commands/version");
      program.addCommand(m.versionCommand);
    },
    test: async () => {
      const m = await import("./commands/test");
      program.addCommand(m.testCommand);
    },
    mine: async () => {
      const m = await import("./commands/mine");
      program.addCommand(m.mineCommand);
    },
    network: async () => {
      const m = await import("./commands/network");
      program.addCommand(m.networkCommand);
    },
    update: async () => {
      const m = await import("./commands/update");
      program.addCommand(m.updateCommand);
    },
  };

  if (!cmdStr || cmdStr === FLAG_HELP_SHORT || cmdStr === FLAG_HELP_LONG) {
    await Promise.all(Object.values(commandMap).map((loader) => loader()));
  } else if (commandMap[cmdStr]) {
    await commandMap[cmdStr]();
  } else {
    await Promise.all(Object.values(commandMap).map((loader) => loader()));
  }

  if (args.length === 0) {
    program.help();
    return;
  }

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    console.error(
      "\x1b[31merror:\x1b[0m command failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(EXIT_FAILURE);
  }
}

try {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(EXIT_FAILURE);
  });
} catch (fatalError) {
  console.error(
    "\x1b[31merror:\x1b[0m cmu failed to start:",
    fatalError instanceof Error ? fatalError.message : String(fatalError),
  );
  process.exit(EXIT_FAILURE);
}
