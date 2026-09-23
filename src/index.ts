#!/usr/bin/env node

// Must stay the first import: imports are hoisted, so anything below this line
// (commander included) loads before a version check placed further down runs.
import "./preflight";

import * as path from "path";
import { Command } from "commander";
import { readPkg } from "./utils/pkg";
import { ariesCommand } from "./commands/aries";
import { auditCommand } from "./commands/audit";
import { compileCommand } from "./commands/compile";
import { consoleCommand } from "./commands/console";
import { createCommand } from "./commands/create";
import { deployCommand } from "./commands/deploy";
import { explorerCommand } from "./commands/explorer";
import { mineCommand } from "./commands/mine";
import { networkCommand } from "./commands/network";
import { nodeCommand } from "./commands/node";
import { testCommand } from "./commands/test";
import { updateCommand } from "./commands/update";
import { versionCommand } from "./commands/version";
import { walletCommand } from "./commands/wallet";

// A missing .env is normal - dotenv was silent about it too, and most
// invocations are outside a project. Anything else (unreadable file, bad
// permissions) is a real problem the user needs to see.
try {
  process.loadEnvFile(path.resolve(process.cwd(), ".env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
process.env.HARDHAT_CONFIG = path.resolve(__dirname, "../hardhat.config.js");

const pkg = readPkg();

const program = new Command();

program
  .name("cmu")
  .option("-v, --verbose", "Print full stack traces on failure")
  .description(
    `${pkg.description}\nTip: Run cmu <command> -h to see detailed options for a specific command.`,
  );

/** Commands that work but are deliberately left out of the help output. */
const HIDDEN_COMMANDS = new Set(["aries"]);

// Registration order is help order.
for (const cmd of [
  compileCommand,
  deployCommand,
  consoleCommand,
  explorerCommand,
  walletCommand,
  createCommand,
  nodeCommand,
  auditCommand,
  ariesCommand,
  versionCommand,
  testCommand,
  mineCommand,
  networkCommand,
  updateCommand,
]) {
  program.addCommand(cmd, { hidden: HIDDEN_COMMANDS.has(cmd.name()) });
}

/**
 * Parses process arguments and runs the matching command.
 * @returns {Promise<void>} Resolves when the command has finished.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmdStr = args[0];

  if (args.length === 1 && (cmdStr === "-V" || cmdStr === "--version")) {
    const { runVersion } = await import("./commands/version");
    await runVersion();
    return;
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
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(
    "\x1b[31merror:\x1b[0m cmu failed to start:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
