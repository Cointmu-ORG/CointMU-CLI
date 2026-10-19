import { Command } from "commander";
import { fail } from "../utils/errors";
import { CommandExitError, run, startFailure } from "../utils/exec";

/**
 * Runs the dependency and Solidity audits in turn.
 *
 * Neither tool reporting findings is a failure of the command: both are
 * downgraded to a warning so a dirty dependency tree does not mask the
 * Solidity pass that follows it. A tool that cannot start at all is: an audit
 * that never ran must not end in "Audit complete." and exit 0.
 *
 * @param {object} options - CLI options.
 * @returns {Promise<void>} Resolves when both passes have run.
 * @throws {Error} When npm or npx cannot be started.
 */
export async function runAudit(options: { fix?: boolean }): Promise<void> {
  console.log("\n\x1b[1m\x1b[34m[1/2] Auditing Node.js dependencies\x1b[0m");

  const npmArgs = ["audit"];
  if (options.fix) {
    npmArgs.push("fix");
  }

  console.log(`\x1b[36m> npm ${npmArgs.join(" ")}\x1b[0m`);
  await run("npm", npmArgs).catch((error: unknown) => {
    if (!(error instanceof CommandExitError)) {
      throw startFailure("npm", error, "cmu audit");
    }
    console.warn(
      "\x1b[33mwarning:\x1b[0m npm audit reported issues in the dependency tree.",
    );
  });

  console.log("\n\x1b[1m\x1b[34m[2/2] Analysing Solidity contracts\x1b[0m");

  const solhintArgs = ["solhint", "contracts/**/*.sol"];
  if (options.fix) {
    solhintArgs.push("--fix");
  }

  console.log(`\x1b[36m> npx ${solhintArgs.join(" ")}\x1b[0m`);
  await run("npx", solhintArgs).catch((error: unknown) => {
    if (!(error instanceof CommandExitError)) {
      throw startFailure("npx", error, "cmu audit");
    }
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
