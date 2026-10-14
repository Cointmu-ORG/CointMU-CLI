import { Command, Option } from "commander";
import { fail } from "../../utils/errors";
import { pingNetwork } from "../deploy";
import { getDynamicNetwork } from "../../utils/network";
import { loadWallets, saveWallet } from "../../utils/walletStorage";
import {
  decryptSessionKey,
  encryptSessionKey,
  requireSession,
} from "../../utils/session";
import {
  requireInteractive,
  promptNewPassword,
  promptOrAbort,
} from "./prompts";
import { sameAddress, checkNewWalletName } from "./savedWallets";
import { runWalletSave } from "./save";
import { runWalletUse } from "./use";
import { runWalletList } from "./list";
import { runWalletDelete } from "./delete";
import { parseTransferAddress, parseTransferAmount } from "./transferInput";
import { unconfirmedHint } from "./transferHint";

export { runWalletSave } from "./save";
export { runWalletUse } from "./use";
export { runWalletList } from "./list";
export { runWalletDelete } from "./delete";
export { parseTransferAddress, parseTransferAmount } from "./transferInput";
export { MINING_PROBE_TIMEOUT_MS } from "./transferHint";

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
 * How long `wallet transfer` waits for its transaction to land in a block.
 *
 * ponytail: picked for the local devnet, which mines on demand. Not yet
 * validated against the server node's block time - mining there has never
 * been tested. Raise it if confirmations routinely take longer.
 */
export const TRANSFER_CONFIRM_TIMEOUT_MS = 120_000;

/** Exit code: the transfer was sent and is in a block. */
export const TRANSFER_SENT = 0;

/**
 * Exit code: the transfer WAS sent but is not confirmed yet. Distinct from 1
 * ("nothing was sent") so a script does not retry it into a double send.
 */
export const TRANSFER_UNCONFIRMED = 2;

/**
 * The short message of an ethers error, without the request payloads its full
 * message carries.
 *
 * @param {unknown} error - The caught value.
 * @returns {string} Something printable.
 */
function shortError(error: unknown): string {
  const short = (error as { shortMessage?: string })?.shortMessage;
  return short ?? (error instanceof Error ? error.message : String(error));
}

/**
 * Sends ETH from the session wallet on the session's active network.
 *
 * Everything that can be checked is checked before the first prompt: the
 * recipient and amount, the session, the node, the balance against
 * amount + max fee, and the zero address under --yes. Only then is the
 * session password asked for, the summary shown and - unless --yes - a No-by-
 * default confirmation asked. --yes skips that one question and nothing else.
 *
 * The key always comes from .cmu-session, never from PRIVATE_KEY: the network
 * and balance shown are the session's, and index.ts loads the project's .env
 * on every run, so an env key would sign from an account the user never saw.
 *
 * Never exits by itself; the handler exits with the code this resolves to.
 *
 * @param {string} toArg - The recipient, as typed.
 * @param {string} amountArg - The amount in ETH, as typed.
 * @param {object} [options]
 * @param {boolean} [options.yes] - Skip the confirmation (`--yes`).
 * @returns {Promise<0 | 2>} TRANSFER_SENT, or TRANSFER_UNCONFIRMED when the
 *   transaction went out but did not land in a block in time.
 * @throws {Error} For anything that stopped it before or at sending, and for a
 *   transaction that was mined but reverted.
 */
export async function runWalletTransfer(
  toArg: string,
  amountArg: string,
  options: { yes?: boolean } = {},
): Promise<0 | 2> {
  const to = await parseTransferAddress(toArg);
  const value = await parseTransferAmount(amountArg);

  const session = await requireSession();
  if (!session.encryptedKey) {
    throw new Error(
      "the session holds no encrypted key.\n" +
        "\x1b[2mhint:\x1b[0m run `cmu wallet use <name>`.",
    );
  }
  const from = session.address;

  const network = await getDynamicNetwork(session.activeNetwork);
  // Fails within its timeout when the node is down; a bare provider would
  // retry network detection forever.
  await pingNetwork(network.rpcUrl, network.name);
  const { ethers } = await import("ethers");
  const provider = new ethers.JsonRpcProvider(network.rpcUrl, undefined, {
    staticNetwork: true,
  });
  const { chainId } = await provider.getNetwork();

  const [balance, feeData, code] = await Promise.all([
    provider.getBalance(from),
    provider.getFeeData(),
    provider.getCode(to),
  ]);
  // Before estimateGas: a node refuses to estimate a transfer the balance
  // cannot cover, which would read as "the recipient rejects it".
  if (balance < value) {
    throw new Error(
      `insufficient balance: ${ethers.formatEther(balance)} ETH, the transfer needs ${ethers.formatEther(value)} ETH plus fee.`,
    );
  }
  let gasLimit: bigint;
  try {
    gasLimit = await provider.estimateGas({ from, to, value });
  } catch (error) {
    throw new Error(
      `${to} would reject this transfer - the node could not estimate it (${shortError(error)}).\n` +
        "\x1b[2mhint:\x1b[0m a contract without a payable receive() or fallback() cannot take plain ETH.",
      { cause: error },
    );
  }

  // Fee fields are sent explicitly, so maxFee is a real ceiling rather than a
  // guess ethers might re-price while populating the transaction.
  const price = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (price == null) {
    throw new Error("the node returned no fee data - cannot bound the fee.");
  }
  const feeFields =
    feeData.maxFeePerGas != null
      ? {
          type: 2,
          maxFeePerGas: feeData.maxFeePerGas,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
        }
      : { type: 0, gasPrice: price };
  const maxFee = gasLimit * price;
  if (balance < value + maxFee) {
    throw new Error(
      `balance ${ethers.formatEther(balance)} ETH covers the amount but not the max fee (${ethers.formatEther(maxFee)} ETH).`,
    );
  }

  const toZero = to === ethers.ZeroAddress;
  if (toZero && options.yes) {
    throw new Error(
      "--yes does not cover sending to the zero address.\n" +
        "\x1b[2mhint:\x1b[0m run without --yes to confirm interactively.",
    );
  }

  const warn = (text: string) => console.log(`\x1b[33mwarning:\x1b[0m ${text}`);
  if (process.env.PRIVATE_KEY) {
    warn(
      "PRIVATE_KEY is set (environment or .env) - transfer ignores it and signs with the session wallet.",
    );
  }
  if (toZero) {
    warn("funds sent to the zero address are burned and cannot be recovered.");
  }
  if (sameAddress(to, from)) {
    warn(`${to} is the sending wallet - this only spends the fee.`);
  }
  if (code !== "0x") {
    warn(`${to} is a contract - plain ETH can be rejected or locked by it.`);
  }

  requireInteractive(
    "the session password",
    "transfer signs with the .cmu-session key and needs its password; run it in a terminal.",
  );
  const inquirer = (await import("inquirer")).default;
  const { password } = await promptOrAbort(() =>
    inquirer.prompt([
      {
        type: "password",
        name: "password",
        message: `Session password for ${from}:`,
        mask: "*",
      },
    ]),
  );
  const signer = new ethers.Wallet(
    decryptSessionKey(password, session),
    provider,
  );
  // The balance above was checked for the plaintext session address; make
  // sure that is really who signs.
  if (!sameAddress(signer.address, from)) {
    throw new Error(
      `.cmu-session names ${from}, but its key belongs to another address - the file has been modified.\n` +
        "\x1b[2mhint:\x1b[0m run `cmu wallet use <name>` again.",
    );
  }

  let savedAs: string | undefined;
  try {
    savedAs = (await loadWallets()).find((w) =>
      sameAddress(w.address, from),
    )?.name;
  } catch {
    // An unreadable wallets file only costs the summary its wallet name.
  }

  console.log("\n--- Transfer ---");
  console.log(`Network : ${network.name} (chain ID ${chainId})`);
  console.log(
    `From    : ${signer.address} (.cmu-session${savedAs ? `, saved as '${savedAs}'` : ""})`,
  );
  console.log(`To      : ${to}`);
  console.log(`Amount  : ${ethers.formatEther(value)} ETH (${value} wei)`);
  console.log(`Max fee : ${ethers.formatEther(maxFee)} ETH`);
  console.log("----------------");

  if (!options.yes) {
    const { proceed } = await promptOrAbort(() =>
      inquirer.prompt([
        {
          type: "confirm",
          name: "proceed",
          message: "Send this transaction?",
          default: false,
        },
      ]),
    );
    if (!proceed) {
      throw new Error("aborted: nothing was sent.");
    }
  }

  let tx;
  try {
    tx = await signer.sendTransaction({ to, value, gasLimit, ...feeFields });
  } catch (error) {
    throw new Error(
      `could not send the transaction: ${shortError(error)}\n` +
        "\x1b[2mhint:\x1b[0m if this was a network error the transaction may still have been broadcast - check `cmu wallet balance` before retrying.",
      { cause: error },
    );
  }
  // Printed before waiting, so a Ctrl-C during the wait still leaves the hash.
  console.log(`Tx hash : ${tx.hash}`);
  console.log(
    `Waiting for 1 confirmation (up to ${TRANSFER_CONFIRM_TIMEOUT_MS / 1000}s)...`,
  );

  let receipt;
  try {
    receipt = await tx.wait(1, TRANSFER_CONFIRM_TIMEOUT_MS);
  } catch (error) {
    if (ethers.isError(error, "CALL_EXCEPTION")) {
      throw new Error(
        `transaction ${tx.hash} was mined but reverted - the fee was paid, the amount was not transferred.`,
        { cause: error },
      );
    }
    // Sent either way, so never the "nothing was sent" exit code.
    warn(
      ethers.isError(error, "TIMEOUT")
        ? `transaction ${tx.hash} was sent but is not in a block after ${TRANSFER_CONFIRM_TIMEOUT_MS / 1000}s.`
        : `transaction ${tx.hash} was sent, but its confirmation could not be checked (${shortError(error)}).`,
    );
    console.log(`\x1b[2mhint:\x1b[0m ${await unconfirmedHint(provider)}`);
    return TRANSFER_UNCONFIRMED;
  }

  const newBalance = await provider.getBalance(from);
  console.log("---------------------------");
  console.log(`Block   : ${receipt?.blockNumber}`);
  console.log(`Balance : ${ethers.formatEther(newBalance)} ETH`);
  console.log("---------------------------");
  return TRANSFER_SENT;
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
