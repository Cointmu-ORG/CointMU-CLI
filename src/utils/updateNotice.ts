import type { Command } from "commander";
import { PACKAGE_NAME } from "../commands/update";
import { readPkg } from "./pkg";

/**
 * The top-level commands the notice follows: the ones run most that end by
 * returning. `deploy` and `console` end in process.exit() inside their
 * action, so no postAction hook ever runs after them.
 */
const NOTICE_COMMANDS = new Set(["create", "compile", "test"]);

/** cmu's own switch, next to update-notifier's NO_UPDATE_NOTIFIER. */
const OPT_OUT_ENV = "CMU_NO_UPDATE_CHECK";
const PACKAGE_OPT_OUT_ENV = "NO_UPDATE_NOTIFIER";

/** update-notifier fills the {placeholders} in; the box is its own. */
const NOTICE =
  "Update available \x1b[2m{currentVersion}\x1b[0m → \x1b[32m{latestVersion}\x1b[0m\nRun \x1b[36mcmu update\x1b[0m to update";

/**
 * Whether this run may show the notice at all: not switched off, a terminal
 * on both streams (it prints to stderr, update-notifier checks stdout), and
 * a command that did not set a failing exit code. CI is left to
 * update-notifier, which turns itself off there.
 *
 * @returns {boolean} True when the notice may be shown.
 */
function isNoticeWanted(): boolean {
  return (
    process.env[OPT_OUT_ENV] !== "1" &&
    !(PACKAGE_OPT_OUT_ENV in process.env) &&
    process.stdout.isTTY === true &&
    process.stderr.isTTY === true &&
    !process.exitCode
  );
}

/**
 * Prints the box if an earlier run's background check found a newer version,
 * and starts the next check when a day has passed. Loaded only here: it is
 * ESM with a few dozen dependencies, and every other command, `--version`
 * and `--help` included, must start as fast as before.
 *
 * @returns {Promise<void>} Resolves once the box, if any, is printed.
 */
async function showUpdateNotice(): Promise<void> {
  const { default: updateNotifier } = await import("update-notifier");
  updateNotifier({
    pkg: { name: PACKAGE_NAME, version: readPkg().version },
  }).notify({ defer: false, message: NOTICE });
}

/**
 * Shows an "update available" notice once a NOTICE_COMMANDS command has
 * succeeded. A failing command ends in process.exit() before the hook runs.
 *
 * @param {Command} program - The root `cmu` program.
 * @returns {void}
 */
export function registerUpdateNotice(program: Command): void {
  program.hook("postAction", async (_root, action) => {
    if (action.parent !== program || !NOTICE_COMMANDS.has(action.name())) {
      return;
    }
    if (isNoticeWanted()) await showUpdateNotice();
  });
}
