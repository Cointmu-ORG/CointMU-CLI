import { Command, Option } from "commander";
import { fail } from "../../utils/errors";
import { getDynamicNetwork } from "../../utils/network";
import { saveWallet } from "../../utils/walletStorage";
import { encryptSessionKey, requireSession } from "../../utils/session";
import { promptNewPassword } from "./prompts";
import { checkNewWalletName } from "./savedWallets";
import { runWalletSave } from "./save";
import { runWalletUse } from "./use";
import { runWalletList } from "./list";
import { runWalletDelete } from "./delete";
import { runWalletTransfer } from "./transfer";

export { runWalletSave } from "./save";
export { runWalletUse } from "./use";
export { runWalletList } from "./list";
export { runWalletDelete } from "./delete";
export { parseTransferAddress, parseTransferAmount } from "./transferInput";
export { MINING_PROBE_TIMEOUT_MS } from "./transferHint";
export {
  TRANSFER_CONFIRM_TIMEOUT_MS,
  TRANSFER_SENT,
  TRANSFER_UNCONFIRMED,
  runWalletTransfer,
} from "./transfer";

/**
 * What scripts still calling the session-only key paths #194 removed in 1.6.0
 * get, instead of commander's "unknown command" / "unknown option".
 */
const REMOVED_LOGIN =
  "removed; use wallet save + wallet use (or wallet create --save)";

/**
 * Generates a new, secure EVM-compatible wallet.
 * @param {object} [options]
 * @param {boolean} [options.login] - Removed; rejected before anything else.
 * @param {string} [options.save] - Encrypt it into the store under this name.
 * @returns {Promise<void>}
 */
export async function runWalletCreate(
  options: { verbose?: boolean; login?: boolean; save?: string } = {},
): Promise<void> {
  if (options.login) throw new Error(REMOVED_LOGIN);
  if (options.save !== undefined) return runWalletCreateSaved(options.save);

  const { ethers } = await import("ethers");
  const wallet = ethers.Wallet.createRandom();

  console.log("New CointMU wallet");
  console.log("===========================");
  console.log(`Address     : ${wallet.address}`);
  console.log(`Private key : ${wallet.privateKey}`);
  if (wallet.mnemonic) {
    console.log(`Mnemonic    : ${wallet.mnemonic.phrase}`);
  }
  console.log("===========================");
  console.log(
    "\n\x1b[33mwarning:\x1b[0m back up the private key and mnemonic now - they are shown once.",
  );
  console.log(
    "Store them offline. Without them the funds in this wallet cannot be recovered.\n",
  );
  console.log(
    "\x1b[33mwarning:\x1b[0m the values above are sensitive and stay behind in terminal",
  );
  console.log(
    "scrollback, tmux or screen logs and CI output. Clear them if this ran anywhere",
  );
  console.log("shared.");
  console.log(
    "\x1b[2mhint:\x1b[0m `cmu wallet create --save <name>` stores the key encrypted and prints only",
  );
  console.log(
    "the address and a mnemonic backup; activate it with `cmu wallet use <name>`.\n",
  );
  console.log("To keep this wallet encrypted and use it in a project, run:");
  console.log("  cmu wallet save <name>");
  console.log("  cmu wallet use <name>");
}

/**
 * `wallet create --save <name>`: generates a wallet straight into the store.
 *
 * Nothing is generated until the name is free and the password confirmed, and
 * nothing is printed until the encrypted entry is on disk, so a failure at any
 * step leaves no mnemonic behind for a wallet that was never saved. The
 * private key is never printed. The store keeps only that key, encrypted, so
 * the printed mnemonic is the one backup.
 *
 * @param {string} name - The name to save the wallet under.
 * @returns {Promise<void>}
 */
async function runWalletCreateSaved(name: string): Promise<void> {
  await checkNewWalletName(name);
  const password = await promptNewPassword("Wallet password:", true);

  const { ethers } = await import("ethers");
  const wallet = ethers.Wallet.createRandom();
  await saveWallet({
    name,
    address: wallet.address,
    ...encryptSessionKey(password, wallet.privateKey),
  });

  console.log("New CointMU wallet");
  console.log("===========================");
  console.log(`Address  : ${wallet.address}`);
  if (wallet.mnemonic) {
    console.log(`Mnemonic : ${wallet.mnemonic.phrase}`);
  }
  console.log("===========================");
  console.log(
    `Saved wallet '${name}' (${wallet.address}), encrypted in ~/.cmu-wallets.json.`,
  );
  console.log(
    "\n\x1b[33mwarning:\x1b[0m write the mnemonic down now - it is shown once and cmu keeps no copy.",
  );
  console.log(
    "~/.cmu-wallets.json holds only the private key, encrypted with your password.",
  );
  console.log(
    "If you lose that file or forget the password, the mnemonic is the only way to",
  );
  console.log(
    "recover this wallet - and anyone who reads it controls the funds.\n",
  );
  console.log(
    "\x1b[33mwarning:\x1b[0m the mnemonic stays behind in terminal scrollback, tmux or screen logs",
  );
  console.log("and CI output. Clear them if this ran anywhere shared.");
  console.log(
    `\x1b[2mhint:\x1b[0m run \`cmu wallet use ${name}\` in a project to make it active there.`,
  );
}

/**
 * Fetch and display the native token balance of the logged-in wallet.
 * @returns {Promise<void>}
 */
async function runWalletBalance(): Promise<void> {
  const session = await requireSession();

  const { ethers } = await import("ethers");

  const network = await getDynamicNetwork(session.activeNetwork);
  const provider = new ethers.JsonRpcProvider(network.rpcUrl);

  console.log(`Connecting to ${network.name} (${network.rpcUrl})...`);
  const balance = await provider.getBalance(session.address);

  console.log("---------------------------");
  console.log(`Address : ${session.address}`);
  console.log(`Balance : ${ethers.formatEther(balance)} ETH`);
  console.log("---------------------------");
}

/**
 * Display the current active wallet session information.
 * @returns {Promise<void>}
 */
async function runWalletInfo(): Promise<void> {
  const session = await requireSession();

  const network = await getDynamicNetwork(session.activeNetwork);

  console.log("--- Active session ---");
  console.log(`Address      : ${session.address}`);
  console.log(`Network      : ${network.name}`);
  console.log(`RPC endpoint : ${network.rpcUrl}`);
  console.log("----------------------");
}

export const walletCommand = new Command("wallet").description(
  "Manage wallets and encrypted sessions",
);

walletCommand
  .command("create")
  .description("Generate a new EVM-compatible wallet")
  .addOption(new Option("--login").hideHelp())
  .option(
    "--save <name>",
    "Encrypt the new key into ~/.cmu-wallets.json under <name> and print only the address and mnemonic",
  )
  .action((options, command) =>
    runWalletCreate(options).catch(
      fail("wallet create", command.optsWithGlobals()),
    ),
  );

// Hidden, and takes anything, so every old invocation reaches REMOVED_LOGIN.
walletCommand
  .command("login", { hidden: true })
  .description(
    "Removed: use `wallet save` + `wallet use` (or `wallet create --save`)",
  )
  .allowUnknownOption()
  .allowExcessArguments()
  .action((options, command) =>
    fail("wallet login", command.optsWithGlobals())(new Error(REMOVED_LOGIN)),
  );

walletCommand
  .command("balance")
  .description("Show the native token balance of the active wallet")
  .action((options, command) =>
    runWalletBalance().catch(fail("wallet balance", command.optsWithGlobals())),
  );

walletCommand
  .command("info")
  .description("Show the active wallet session")
  .action((options, command) =>
    runWalletInfo().catch(fail("wallet info", command.optsWithGlobals())),
  );

walletCommand
  .command("save <name>")
  .alias("add")
  .description("Save a private key as a named, encrypted wallet")
  .option(
    "--session",
    "Save the key in this project's .cmu-session instead of prompting for one",
  )
  .action((name, options, command) =>
    runWalletSave(name, options).catch(
      fail("wallet save", command.optsWithGlobals()),
    ),
  );

walletCommand
  .command("use <name>")
  .description("Make a saved wallet the active session in this project")
  .action((name, options, command) =>
    runWalletUse(name).catch(fail("wallet use", command.optsWithGlobals())),
  );

walletCommand
  .command("list")
  .description("List saved wallets")
  .action((options, command) =>
    runWalletList().catch(fail("wallet list", command.optsWithGlobals())),
  );

walletCommand
  .command("delete <name>")
  .description("Delete a saved wallet")
  .option("-y, --yes", "Delete without asking for confirmation")
  .action((name, options, command) =>
    runWalletDelete(name, options).catch(
      fail("wallet delete", command.optsWithGlobals()),
    ),
  );

walletCommand
  .command("transfer <to> <amount>")
  .alias("tf")
  .description("Send ETH from the session wallet")
  .option("-y, --yes", "Send without asking for confirmation")
  // The exit code comes from the return value: exit 2 (sent, unconfirmed)
  // must not be flattened into the 0 other provider-holding commands force.
  .action((to, amount, options, command) =>
    runWalletTransfer(to, amount, options).then(
      (code) => process.exit(code),
      fail("wallet transfer", command.optsWithGlobals()),
    ),
  );
