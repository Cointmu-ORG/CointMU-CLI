import { loadWallets } from "../../utils/walletStorage";
import { decryptSessionKey } from "../../utils/session";
import {
  describeSessionFile,
  getGlobalSessionFilePath,
  getLocalSessionFilePath,
  getSessionFilePath,
} from "../../utils/sessionLocation";
import { requireInteractive, promptOrAbort } from "./prompts";
import { sameAddress, findWallet } from "./savedWallets";
import { storeSession } from "./activeSession";

/**
 * Makes a saved wallet the active session: in ~/.cmu-session, which every
 * folder without its own .cmu-session uses, or in the working folder's
 * .cmu-session when it has one or `--local` asks for one.
 *
 * The wallet's password is checked by decrypting, and the address is taken
 * from the decrypted key: the stored one is plaintext and not covered by the
 * GCM tag. The ciphertext is then copied into the session file as is - same
 * plaintext, key and IV, so the copy is byte-identical - and the session opens
 * with the wallet's password. It is a copy: deleting the wallet later does not
 * touch this session.
 *
 * @param {string} name - The wallet to activate.
 * @param {object} [options]
 * @param {boolean} [options.local] - Write the working folder's .cmu-session,
 *   creating the override if there is none yet.
 * @returns {Promise<void>}
 */
export async function runWalletUse(
  name: string,
  options: { local?: boolean } = {},
): Promise<void> {
  const wallet = findWallet(await loadWallets(), name);
  const target = options.local
    ? getLocalSessionFilePath()
    : getSessionFilePath();
  const file = describeSessionFile(target);

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
      `aborted: ${file} was not changed.`,
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
  }, target);
  console.log(`Active wallet is now '${name}' (${address})`);
  console.log(`Active network: ${activeNetwork}`);
  console.log(`Session: ${file} (${sessionScope(target)})`);
}

/**
 * Where a session file applies, for the line `use` ends with.
 *
 * @param {string} sessionFile - The file just written.
 * @returns {string} The folders it is in effect for.
 */
function sessionScope(sessionFile: string): string {
  return sessionFile === getGlobalSessionFilePath()
    ? "every folder without its own .cmu-session"
    : "this folder only; ~/.cmu-session is unchanged";
}
