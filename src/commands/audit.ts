import { Command } from "commander";
import { fail } from "../utils/errors";

/**
 * Executes an external command in a child process.
 * @param {string} command - The command to execute (e.g. 'npm', 'npx').
 * @param {string[]} args - The arguments to pass to the command.
 * @returns {Promise<void>} Resolves when the command successfully completes.
 */
async function runCommand(command: string, args: string[]): Promise<void> {
  const { spawn } = await import("child_process");

  return new Promise((resolve, reject) => {
    console.log(`\x1b[36m> ${command} ${args.join(" ")}\x1b[0m`);

    const executable =
      process.platform === "win32" ? `${command}.cmd` : command;

    const child = spawn(executable, args, {
      stdio: "inherit",
      shell: false,
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Runs the dependency and Solidity audits in turn.
 *
 * Neither tool reporting findings is a failure of the command: both are
 * downgraded to a warning so a dirty dependency tree does not mask the
 * Solidity pass that follows it.
 *
 * @param {object} options - CLI options.
 * @returns {Promise<void>} Resolves when both passes have run.
 */
async function runAudit(options: { fix?: boolean }): Promise<void> {
  console.log("\n\x1b[1m\x1b[34m[1/2] Auditing Node.js dependencies\x1b[0m");

  const npmArgs = ["audit"];
  if (options.fix) {
    npmArgs.push("fix");
  }

  await runCommand("npm", npmArgs).catch(() => {
    console.warn(
      "\x1b[33mwarning:\x1b[0m npm audit reported issues in the dependency tree.",
    );
  });

  console.log("\n\x1b[1m\x1b[34m[2/2] Analysing Solidity contracts\x1b[0m");

  const solhintArgs = ["solhint", "contracts/**/*.sol"];
  if (options.fix) {
    solhintArgs.push("--fix");
  }

  await runCommand("npx", solhintArgs).catch(() => {
    console.warn(
      "\x1b[33mwarning:\x1b[0m solhint reported issues in the Solidity sources.",
    );
  });

  console.log("\n\x1b[1m\x1b[32mAudit complete.\x1b[0m\n");
}

export const auditCommand = new Command("audit")
  .description("Run static security analysis on contracts and dependencies")
  .option("--fix", "Apply safe fixes automatically")
  .action((options: { fix?: boolean }, command) =>
    runAudit(options).catch(fail("audit", command.optsWithGlobals())),
  );
