import { Command } from "commander";
import { printCliError } from "../utils/errors";

const EXIT_FAILURE = 1;

/**
 * Validates that a string is a well-formed HTTP or HTTPS URL.
 * @param {string} value - The URL string to validate.
 * @returns {boolean} True if the value is a valid http or https URL.
 */
function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Executes the explorer opening logic.
 * @param {object} options - CLI options.
 * @returns {Promise<void>} Resolves when the explorer launch command is spawned.
 */
async function runExplorerOpen(
  options: { verbose?: boolean } = {},
): Promise<void> {
  try {
    const { spawn } = await import("child_process");
    const { loadConfig } = await import("../utils/config");

    let explorerUrl = "http://localhost:3000";

    try {
      const config = await loadConfig();
      if (config?.network?.explorerUrl) {
        explorerUrl = config.network.explorerUrl;
      }
    } catch {
      // Fallback to default if config is missing or invalid
    }

    if (!isValidHttpUrl(explorerUrl)) {
      throw new Error(
        `invalid explorer URL '${explorerUrl}'.\n` +
          "\x1b[2mhint:\x1b[0m set network.explorerUrl in cmu.config.ts to an http or https URL.",
      );
    }

    console.log(`Opening the CointMU explorer at ${explorerUrl}...`);

    const child =
      process.platform === "win32"
        ? spawn("cmd", ["/c", "start", "", explorerUrl], { shell: false })
        : spawn(
            process.platform === "darwin" ? "open" : "xdg-open",
            [explorerUrl],
            { shell: false },
          );

    child.on("error", (error) => {
      console.error(
        "\x1b[33mwarning:\x1b[0m could not open a browser; open the URL above manually.",
      );
      if (options.verbose) {
        printCliError(error, true);
      }
    });
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m explorer open failed");

    printCliError(error, options.verbose);

    process.exit(EXIT_FAILURE);
  }
}

export const explorerCommand = new Command("explorer").description(
  "Work with the block explorer",
);

explorerCommand
  .command("open")
  .description("Open the CointMU block explorer in a browser")
  .option("-v, --verbose", "Print full stack traces on failure")
  .action(runExplorerOpen);
