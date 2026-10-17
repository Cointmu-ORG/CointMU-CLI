import { deleteWallet, loadWallets } from "../../utils/walletStorage";
import { requireInteractive, promptOrAbort } from "./prompts";
import { sameAddress, findWallet } from "./savedWallets";
import { sessionAddress } from "./activeSession";

/**
 * Deletes a saved wallet after confirmation. Sessions that already `use` it
 * hold their own encrypted copy, so they keep working.
 *
 * @param {string} name - The wallet to delete.
 * @param {object} [options]
 * @param {boolean} [options.yes] - Skip the confirmation (`--yes`).
 * @returns {Promise<void>}
 */
export async function runWalletDelete(
  name: string,
  options: { yes?: boolean } = {},
): Promise<void> {
  const wallet = findWallet(await loadWallets(), name);

  if (!options.yes) {
    requireInteractive(
      "confirmation",
      "re-run with --yes to delete without asking.",
    );
    const inquirer = (await import("inquirer")).default;
    const { proceed } = await promptOrAbort(
      () =>
        inquirer.prompt([
          {
            type: "confirm",
            name: "proceed",
            message: `Delete wallet '${name}' (${wallet.address})? cmu keeps no other copy of its key.`,
            default: false,
          },
        ]),
      "aborted: nothing was deleted.",
    );
    if (!proceed) {
      console.log("Nothing deleted.");
      return;
    }
  }

  await deleteWallet(name);
  console.log(`Deleted wallet '${name}'.`);
  if (sameAddress(await sessionAddress(), wallet.address)) {
    console.log(
      "This project's .cmu-session keeps its own copy and still works.",
    );
  }
  console.log(
    `\x1b[2mhint:\x1b[0m projects that already ran \`cmu wallet use ${name}\` keep their own encrypted copy in .cmu-session.`,
  );
}
