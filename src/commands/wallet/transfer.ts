import { pingNetwork } from "../deploy";
import { coinSymbol } from "../../utils/coinSymbol";
import { getDynamicNetwork } from "../../utils/network";
import { loadWallets } from "../../utils/walletStorage";
import { decryptSessionKey, requireSession } from "../../utils/session";
import { requireInteractive, promptOrAbort } from "./prompts";
import { sameAddress } from "./savedWallets";
import { parseTransferAddress, parseTransferAmount } from "./transferInput";
import { unconfirmedHint } from "./transferHint";

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

/** What a declined or cancelled transfer says. */
const NOTHING_SENT = "aborted: nothing was sent.";

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
  // Before any RPC: a broken symbol fails without dialling the node.
  const symbol = coinSymbol(network);
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
      `insufficient balance: ${ethers.formatEther(balance)} ${symbol}, the transfer needs ${ethers.formatEther(value)} ${symbol} plus fee.`,
    );
  }
  let gasLimit: bigint;
  try {
    gasLimit = await provider.estimateGas({ from, to, value });
  } catch (error) {
    throw new Error(
      `${to} would reject this transfer - the node could not estimate it (${shortError(error)}).\n` +
        `\x1b[2mhint:\x1b[0m a contract without a payable receive() or fallback() cannot take plain ${symbol}.`,
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
      `balance ${ethers.formatEther(balance)} ${symbol} covers the amount but not the max fee (${ethers.formatEther(maxFee)} ${symbol}).`,
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
    warn(
      `${to} is a contract - plain ${symbol} can be rejected or locked by it.`,
    );
  }

  requireInteractive(
    "the session password",
    "transfer signs with the .cmu-session key and needs its password; run it in a terminal.",
  );
  const inquirer = (await import("inquirer")).default;
  const { password } = await promptOrAbort(
    () =>
      inquirer.prompt([
        {
          type: "password",
          name: "password",
          message: `Session password for ${from}:`,
          mask: "*",
        },
      ]),
    NOTHING_SENT,
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
  console.log(
    `Amount  : ${ethers.formatEther(value)} ${symbol} (${value} wei)`,
  );
  console.log(`Max fee : ${ethers.formatEther(maxFee)} ${symbol}`);
  console.log("----------------");

  if (!options.yes) {
    const { proceed } = await promptOrAbort(
      () =>
        inquirer.prompt([
          {
            type: "confirm",
            name: "proceed",
            message: "Send this transaction?",
            default: false,
          },
        ]),
      NOTHING_SENT,
    );
    if (!proceed) {
      throw new Error(NOTHING_SENT);
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
  console.log(`Balance : ${ethers.formatEther(newBalance)} ${symbol}`);
  console.log("---------------------------");
  return TRANSFER_SENT;
}
