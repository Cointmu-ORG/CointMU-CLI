import { saveWallet, type WalletEntry } from "../../utils/walletStorage";
import {
  encryptSessionKey,
  LEGACY_PBKDF2_ITERATIONS,
} from "../../utils/session";
import {
  promptPrivateKey,
  promptNewPassword,
  promptOrAbort,
  NOTHING_SAVED,
} from "./prompts";
import { sameAddress, checkNewWalletName } from "./savedWallets";
import {
  parseSession,
  sessionHoldsOpenableKey,
  UNPARSEABLE_SESSION,
} from "./activeSession";

/**
 * `wallet save <name> --session`: copies this project's session key into the
 * store as is, the reverse of `use`. The ciphertext is never decrypted, so
 * nothing is prompted and no key is in memory; the entry opens with the
 * session's password.
 *
 * The session address is plaintext and not covered by the GCM tag. An edited
 * one gives an entry `use` refuses, since `use` checks the decrypted address.
 *
 * @param {string} name - The name to save the wallet under.
 * @param {WalletEntry[]} wallets - The wallets already saved.
 * @returns {Promise<void>}
 */
async function saveSessionKey(
  name: string,
  wallets: WalletEntry[],
): Promise<void> {
  const session = await parseSession();
  if (session === UNPARSEABLE_SESSION) {
    throw new Error(
      ".cmu-session is not valid JSON, so cmu cannot read a key from it.\n" +
        "\x1b[2mhint:\x1b[0m fix the file, then run this command again.",
    );
  }
  if (session?.encryptedKey && !sessionHoldsOpenableKey(session)) {
    throw new Error(
      `this project's .cmu-session holds an encrypted key for ${session.address} that this version of cmu cannot open or save (written by cmu 1.3.1 or older, or incomplete).\n` +
        "\x1b[2mhint:\x1b[0m keep a copy of the file somewhere safe; `cmu wallet use` also keeps one as .cmu-session.bak-<time> before replacing it.",
    );
  }
  if (!session || !sessionHoldsOpenableKey(session)) {
    throw new Error(
      "this project's .cmu-session holds no key to save.\n" +
        "\x1b[2mhint:\x1b[0m run it in the project directory whose session you want to keep.",
    );
  }
  const twin = wallets.find((w) => sameAddress(w.address, session.address));
  if (twin) {
    throw new Error(
      `this session's key is already saved as '${twin.name}'.\n` +
        `\x1b[2mhint:\x1b[0m nothing to do; \`cmu wallet use ${twin.name}\` brings it back.`,
    );
  }

  const { address, encryptedKey, salt, iv, authTag } = session;
  await saveWallet({
    name,
    address,
    encryptedKey,
    salt,
    iv,
    authTag,
    iterations: session.iterations ?? LEGACY_PBKDF2_ITERATIONS,
  });
  console.log(`Saved wallet '${name}' (${address}) from .cmu-session.`);
  console.log("It opens with this session's password.");
  console.log(
    `\x1b[2mhint:\x1b[0m run \`cmu wallet use ${name}\` in a project to make it active there.`,
  );
}

/**
 * Saves a private key as a named wallet in ~/.cmu-wallets.json, encrypted
 * with its own password. The name is checked before anything is prompted.
 *
 * @param {string} name - The name to save the wallet under.
 * @param {object} [options]
 * @param {boolean} [options.session] - Save this project's session key
 *   instead of prompting for one.
 * @returns {Promise<void>}
 */
export async function runWalletSave(
  name: string,
  options: { session?: boolean } = {},
): Promise<void> {
  const wallets = await checkNewWalletName(name);
  if (options.session) return saveSessionKey(name, wallets);

  const privateKey = await promptOrAbort(promptPrivateKey, NOTHING_SAVED);
  const { ethers } = await import("ethers");
  const { address } = new ethers.Wallet(privateKey);

  const twin = wallets.find((w) => sameAddress(w.address, address));
  if (twin) {
    console.log(
      `\x1b[33mwarning:\x1b[0m this key is already saved as '${twin.name}'.`,
    );
  }

  const password = await promptOrAbort(
    () => promptNewPassword("Wallet password:", true),
    NOTHING_SAVED,
  );
  await saveWallet({
    name,
    address,
    ...encryptSessionKey(password, privateKey),
  });

  console.log(`Saved wallet '${name}' (${address})`);
  console.log(
    `\x1b[2mhint:\x1b[0m run \`cmu wallet use ${name}\` in a project to make it active there.`,
  );
}
