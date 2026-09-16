#!/usr/bin/env node

// Must stay the first import: imports are hoisted, so anything below this line
// (commander included) loads before a version check placed further down runs.
import "./preflight";

import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";

const EXIT_FAILURE = 1;

// A missing .env is normal - dotenv was silent about it too, and most
// invocations are outside a project. Anything else (unreadable file, bad
// permissions) is a real problem the user needs to see.
try {
  process.loadEnvFile(path.resolve(process.cwd(), ".env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
process.env.HARDHAT_CONFIG = path.resolve(__dirname, "../hardhat.config.js");

const pkgPath = path.resolve(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

const program = new Command();

program
  .name("cmu")
  .description(
    `${pkg.description}\nTip: Run cmu <command> -h to see detailed options for a specific command.`,
  );

/**
 * Every command the CLI can register, keyed by the name typed on the command
 * line. The import specifiers stay literal: tsup bundles from a single entry
 * with code splitting off, and esbuild cannot follow a computed path.
 */
const commandMap: Record<string, () => Promise<Record<string, any>>> = {
  compile: () => import("./commands/compile"),
  deploy: () => import("./commands/deploy"),
  wallet: () => import("./commands/wallet"),
  create: () => import("./commands/create"),
  node: () => import("./commands/node"),
  audit: () => import("./commands/audit"),
  aries: () => import("./commands/aries"),
  version: () => import("./commands/version"),
  test: () => import("./commands/test"),
  mine: () => import("./commands/mine"),
  network: () => import("./commands/network"),
  update: () => import("./commands/update"),
};

/** Commands that work but are deliberately left out of the help output. */
const HIDDEN_COMMANDS = new Set(["aries"]);

/**
 * Loads the named command modules and registers each one on the program.
 * Every module exports its command as `<name>Command`.
 *
 * @param {string[]} names - Keys of commandMap to register.
 * @returns {Promise<void>} Resolves once all of them are registered.
 */
async function registerCommands(names: string[]): Promise<void> {
  await Promise.all(
    names.map(async (name) => {
      const module: Record<string, any> =
        await commandMap[name as keyof typeof commandMap]();
      program.addCommand(module[`${name}Command`], {
        hidden: HIDDEN_COMMANDS.has(name),
      });
    }),
  );
}

/**
 * Loads the requested command module, or all modules if help is requested.
 * Registers them on the program, then parses process arguments asynchronously.
 * @returns {Promise<void>} Resolves when all required commands are registered and arguments are parsed.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmdStr = args[0];

  if (args.length === 1 && (cmdStr === "-V" || cmdStr === "--version")) {
    const { runVersion } = await import("./commands/version");
    await runVersion();
    return;
  }

  // A known command loads on its own. Anything else - no command, an unknown
  // one, -h/--help, a bare flag - loads everything, so commander can render
  // full help or report the command as unknown.
  await registerCommands(
    commandMap[cmdStr] ? [cmdStr] : Object.keys(commandMap),
  );

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

main().catch((error) => {
  console.error(
    "\x1b[31merror:\x1b[0m cmu failed to start:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(EXIT_FAILURE);
});
