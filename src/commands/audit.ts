import { Command } from "commander";

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

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
      if (code !== EXIT_SUCCESS) {
        reject(new Error(`${command} exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

export const auditCommand = new Command("audit")
  .description("Run static security analysis on contracts and dependencies")
  .option("--fix", "Apply safe fixes automatically")
  .option("-v, --verbose", "Print full stack traces on failure")
  .action(async (options: { fix?: boolean; verbose?: boolean }) => {
    try {
      console.log(
        "\n\x1b[1m\x1b[34m[1/2] Auditing Node.js dependencies\x1b[0m",
      );

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
    } catch (error) {
      console.error("\n\x1b[31merror:\x1b[0m audit failed");

      if (options.verbose) {
        console.error(error);
      } else {
        console.error(error instanceof Error ? error.message : String(error));
      }

      process.exit(EXIT_FAILURE);
    }
  });
