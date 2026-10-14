import { loadWallets } from "../../utils/walletStorage";
import { sameAddress } from "./savedWallets";
import { sessionAddress } from "./activeSession";

/**
 * Lists the saved wallets, marking the ones this project's session holds.
 * @returns {Promise<void>}
 */
export async function runWalletList(): Promise<void> {
  const wallets = await loadWallets();
  if (wallets.length === 0) {
    console.log("No saved wallets.");
    console.log("\x1b[2mhint:\x1b[0m save one with `cmu wallet save <name>`.");
    return;
  }
  const active = await sessionAddress();

  console.log("\nSaved wallets");
  console.log(
    "==========================================================================",
  );
  console.log("| Active | Name                             | Address");
  console.log(
    "--------------------------------------------------------------------------",
  );
  for (const w of wallets) {
    const isActive = sameAddress(w.address, active) ? "[*]   " : "      ";
    console.log(`| ${isActive} | ${w.name.padEnd(32)} | ${w.address}`);
  }
  console.log(
    "==========================================================================\n",
  );
}
