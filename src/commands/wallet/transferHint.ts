import type { JsonRpcProvider } from "ethers";
import { optional } from "../mine";

/**
 * How long the hint after an unconfirmed transfer waits for eth_mining. It
 * only picks the hint's wording, so it is kept short.
 */
export const MINING_PROBE_TIMEOUT_MS = 3_000;

/** Every unconfirmed-transfer hint ends with this: a retry can send twice. */
const RECHECK_BALANCE = "check `cmu wallet balance` before sending again.";

/**
 * The hint for a transfer that was sent but is not confirmed, worded for what
 * the node can do. The local DevNet has no eth_mining and puts each
 * transaction in a block at once; a geth node only makes blocks while it
 * mines, and `mine start` there moves its etherbase for everyone.
 *
 * @param {JsonRpcProvider} provider - Provider for the active network.
 * @returns {Promise<string>} The hint, without the "hint:" prefix.
 */
export async function unconfirmedHint(
  provider: JsonRpcProvider,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const noAnswer = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), MINING_PROBE_TIMEOUT_MS);
  });
  // A node that fails or does not answer gets the generic hint (undefined).
  const mining = await Promise.race([
    optional<boolean>(provider.send("eth_mining", [])),
    noAnswer,
  ])
    .catch(() => undefined)
    .finally(() => clearTimeout(timer));

  if (mining === null) {
    return `the local DevNet puts each transaction in a block at once, so a missing confirmation means the node stopped or dropped it - check it is still running (\`cmu node start\`), then ${RECHECK_BALANCE}`;
  }
  if (mining === true) {
    return `this node is mining, but the first block after a start can take minutes while ethash builds its DAG - wait a little (\`cmu mine status\` shows progress), then ${RECHECK_BALANCE}`;
  }
  if (mining === false) {
    return `blocks only appear while this node mines - \`cmu mine status\` shows whether it does and where its rewards go. \`cmu mine start\` would move the node's etherbase to your wallet for everyone. Either way, ${RECHECK_BALANCE}`;
  }
  return `the node did not answer a follow-up check - make sure it is still reachable, then ${RECHECK_BALANCE}`;
}
