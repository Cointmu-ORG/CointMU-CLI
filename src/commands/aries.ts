import { Command } from "commander";
import { fail } from "../utils/errors";

const DIM_COLOR = "\x1b[2m";
const CYAN_COLOR = "\x1b[36m";
const GREEN_COLOR = "\x1b[32m";
const RESET_COLOR = "\x1b[0m";

/**
 * Executes the hidden easter egg sequence.
 * @returns {Promise<void>}
 */
async function runAries(): Promise<void> {
  const { pick, SAD_QUOTES } = await import("../utils/quotes");

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
  console.log(`${GREEN_COLOR} > ${pick(SAD_QUOTES)}${RESET_COLOR}`);
}

export const ariesCommand = new Command("aries")
  .description("Hidden easter egg command")
  .action((options, command) =>
    runAries().catch(fail("aries", command.optsWithGlobals())),
  );
