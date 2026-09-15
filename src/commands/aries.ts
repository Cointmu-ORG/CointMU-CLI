import { Command } from "commander";
import { printCliError } from "../utils/errors";

const EXIT_FAILURE = 1;
const DIM_COLOR = "\x1b[2m";
const CYAN_COLOR = "\x1b[36m";
const GREEN_COLOR = "\x1b[32m";
const RESET_COLOR = "\x1b[0m";

/**
 * Executes the hidden easter egg sequence.
 * @param {object} options - CLI options.
 * @returns {Promise<void>}
 */
async function runAries(options: { verbose?: boolean } = {}): Promise<void> {
  try {
    const { getRandomSadQuote } = await import("../utils/quotes");

    console.log(
      `${DIM_COLOR}init: connecting to peer 127.0.0.1:8333...${RESET_COLOR}`,
    );
    console.log(
      `${DIM_COLOR}init: bypassing standard consensus protocols...${RESET_COLOR}`,
    );
    console.log(
      `${DIM_COLOR}init: accessing genesis block data...${RESET_COLOR}`,
    );
    console.log("");
    console.log(
      `${CYAN_COLOR} > HW! aries instance awakened at Universitas Muhammadiyah Yogyakarta.${RESET_COLOR}`,
    );
    console.log(
      `${CYAN_COLOR} > The architect behind the scenes is watching.${RESET_COLOR}`,
    );
    console.log(`${GREEN_COLOR} > ${getRandomSadQuote()}${RESET_COLOR}`);
  } catch (error) {
    console.error("\n\x1b[31merror:\x1b[0m aries failed");
    printCliError(error, options.verbose);
    process.exit(EXIT_FAILURE);
  }
}

export const ariesCommand = new Command("aries")
  .description("Hidden easter egg command")
  .option("-v, --verbose", "Print full stack traces on failure")
  .action(runAries);
