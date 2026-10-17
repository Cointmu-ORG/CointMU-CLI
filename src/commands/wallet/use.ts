import { loadWallets } from "../../utils/walletStorage";
import { decryptSessionKey } from "../../utils/session";
import { requireInteractive, promptOrAbort } from "./prompts";
import { sameAddress, findWallet } from "./savedWallets";
import { storeSession } from "./activeSession";

/**
 * Makes a saved wallet the active session of the current project.
 *
 * The wallet's password is checked by decrypting, and the address is taken
 * from the decrypted key: the stored one is plaintext and not covered by the
 * GCM tag. The ciphertext is then copied into .cmu-session as is - same
 * plaintext, key and IV, so the copy is byte-identical - and the session opens
 * with the wallet's password. It is a copy: deleting the wallet later does not
 * touch this session.
 *
 * @param {string} name - The wallet to activate.
 * @returns {Promise<void>}
 */
export async function runWalletUse(name: string): Promise<void> {
  const wallet = findWallet(await loadWallets(), name);

  // The stored address is plaintext and not covered by the GCM tag, so unlock
  // re-derives it from the key and refuses a mismatch before anything is written.
  const { address, activeNetwork } = await storeSession(async () => {
    requireInteractive("a password");
    const inquirer = (await import("inquirer")).default;
    const { password } = await promptOrAbort(
      () =>
        inquirer.prompt([
          {
            type: "password",
            name: "password",
            message: `Password for wallet '${name}':`,
            mask: "*",
          },
        ]),
      "aborted: .cmu-session was not changed.",
    );

    let privateKey: string;
    try {
      privateKey = decryptSessionKey(password, wallet);
    } catch {
      throw new Error(
        `wrong password for wallet '${name}', or ~/.cmu-wallets.json has been tampered with.\n` +
          `\x1b[2mhint:\x1b[0m retype the password '${name}' was saved with - cmu cannot recover a forgotten one.`,
      );
    }
    const { ethers } = await import("ethers");
    const { address } = new ethers.Wallet(privateKey);
    if (!sameAddress(address, wallet.address)) {
      throw new Error(
        `wallet '${name}' does not hold the key for ${wallet.address} - ~/.cmu-wallets.json has been modified.\n` +
          `\x1b[2mhint:\x1b[0m run \`cmu wallet delete ${name}\` and save the key again.`,
      );
    }

    const { encryptedKey, salt, iv, authTag, iterations } = wallet;
    return {
      address,
      encrypted: { encryptedKey, salt, iv, authTag, iterations },
    };
  });
  console.log(`Active wallet is now '${name}' (${address})`);
  console.log(`Active network: ${activeNetwork}`);
}
