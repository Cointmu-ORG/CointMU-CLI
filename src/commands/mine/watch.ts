import type { Block, JsonRpcProvider } from "ethers";
import { setTimeout as delay } from "timers/promises";
import {
  WARNING,
  sameAddress,
  formatHashrate,
  type MiningStatus,
  readStatus,
} from "./status";

/** Carriage return + erase line: redraws the watch's status line in place. */
const CLEAR_LINE = "\r\x1b[2K";

/** About a third of the server's ~13 s block time. */
const POLL_MS = 4000;
const MAX_BACKOFF_MS = 60000;

// ponytail: an outage longer than this many blocks leaves the older ones
// uncounted; page through them if long outages turn out to matter.
const MAX_BLOCKS_PER_POLL = 100;

interface WatchState {
  address: string;
  startHeight: number;
  startBalance: bigint;
  /** Every block since the start, by number: what the count is taken from. */
  seen: Map<number, { hash: string; mine: boolean }>;
  head: number;
  mining: boolean | null;
  coinbase: string | null;
}

/**
 * Events for a change in the node's etherbase or mining flag since the last
 * poll - one per change, not one per poll. An unsupported method (null) is
 * never a change.
 */
function nodeEvents(state: WatchState, status: MiningStatus): string[] {
  const events: string[] = [];
  const { mining, coinbase } = status;

  if (
    coinbase !== null &&
    state.coinbase !== null &&
    !sameAddress(coinbase, state.coinbase)
  ) {
    events.push(
      sameAddress(coinbase, state.address)
        ? `etherbase is back on your wallet: rewards go to ${state.address} again.`
        : `${WARNING} etherbase changed: rewards now go to ${coinbase}, not your wallet.`,
    );
  }
  if (mining !== null && state.mining !== null && mining !== state.mining) {
    events.push(
      mining
        ? "mining resumed."
        : `${WARNING} mining stopped - someone ran \`cmu mine stop\`, or the node stopped its miner.`,
    );
  }

  if (coinbase !== null) state.coinbase = coinbase;
  if (mining !== null) state.mining = mining;
  return events;
}

/**
 * Brings `state.seen` up to the new head. Walks back from it by parent hash
 * until it meets a block already seen, which covers both a gap between polls
 * (every block in between is fetched) and a reorg (a replaced block's hash no
 * longer matches, so it is fetched again and overwritten).
 */
async function blockEvents(
  provider: JsonRpcProvider,
  state: WatchState,
  latest: Block,
): Promise<string[]> {
  const events: string[] = [];
  if (state.seen.get(latest.number)?.hash === latest.hash) return events;

  const fresh: Block[] = [latest];
  let block = latest;
  while (
    block.number > state.startHeight + 1 &&
    fresh.length < MAX_BLOCKS_PER_POLL &&
    state.seen.get(block.number - 1)?.hash !== block.parentHash
  ) {
    const parent = await provider.getBlock(block.number - 1);
    if (!parent)
      throw new Error(`the node returned no block #${block.number - 1}.`);
    block = parent;
    fresh.unshift(block);
  }

  // A shorter replacement chain leaves entries above the new head behind.
  const dropped = [...state.seen.keys()].filter((n) => n > latest.number);
  dropped.forEach((n) => state.seen.delete(n));
  let reorgFrom = dropped.length ? Math.min(...dropped) : undefined;

  for (const b of fresh) {
    const known = state.seen.get(b.number);
    if (known && known.hash !== b.hash) {
      reorgFrom = Math.min(reorgFrom ?? b.number, b.number);
    }
    const mine =
      b.number > state.startHeight && sameAddress(b.miner, state.address);
    if (mine && known?.hash !== b.hash) {
      events.push(`block #${b.number} mined by you.`);
    }
    state.seen.set(b.number, { hash: b.hash!, mine });
  }

  if (reorgFrom !== undefined) {
    events.unshift(
      `reorg: blocks from #${reorgFrom} were replaced; the count is redone.`,
    );
  }
  state.head = latest.number;
  return events;
}

/** Retry delay after `failures` failed polls in a row: 4 s doubling to 60 s. */
export function backoff(failures: number): number {
  return Math.min(POLL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
}

function errorText(error: unknown): string {
  const e = error as { shortMessage?: string; message?: string };
  return e?.shortMessage ?? e?.message ?? String(error);
}

/**
 * Polls the node until `signal` aborts, printing height, hashrate, blocks
 * mined by `address` since the start and its balance. A failed poll is
 * reported and retried with backoff, never thrown: the watch outlives a node
 * restart. Resolves (does not reject) when aborted, including mid-sleep.
 *
 * @param {JsonRpcProvider} provider - Provider for the active network.
 * @param {string} address - The session wallet the rewards should go to.
 * @param {AbortSignal} signal - Aborted on Ctrl-C.
 * @param {Function} [sleep] - Waits between polls; injectable for tests.
 * @returns {Promise<void>} Resolves once aborted.
 */
export async function watchMining(
  provider: JsonRpcProvider,
  address: string,
  signal: AbortSignal,
  sleep: (ms: number, signal: AbortSignal) => Promise<unknown> = (ms, s) =>
    delay(ms, undefined, { signal: s }),
): Promise<void> {
  const { formatEther } = await import("ethers");
  const tty = Boolean(process.stdout.isTTY);
  // Redraw in a terminal; one line per event anywhere else, so logs stay clean.
  const print = (line: string) =>
    tty ? process.stdout.write(`${CLEAR_LINE}${line}\n`) : console.log(line);

  let state: WatchState | undefined;
  let failures = 0;
  let statusLine = "";

  const step = async () => {
    try {
      const status = await readStatus(provider, address);
      if (failures) print("reconnected.");
      failures = 0;
      const previousHead = state?.head;

      if (!state) {
        // Expect the etherbase `mine start` just set, so a takeover between
        // the start and this first poll is reported too. The mining flag is
        // taken as first seen: geth reports false until it has synced.
        state = {
          address,
          startHeight: status.block.number,
          startBalance: status.balance,
          seen: new Map([
            [status.block.number, { hash: status.block.hash!, mine: false }],
          ]),
          head: status.block.number,
          mining: null,
          coinbase: address,
        };
      }
      // Printed before the block fetch, which can still fail: nodeEvents()
      // has already recorded the change, so it would not be reported again.
      nodeEvents(state, status).forEach(print);
      const events = await blockEvents(provider, state, status.block);

      const mined = [...state.seen.values()].filter((b) => b.mine).length;
      const change = status.balance - state.startBalance;
      statusLine =
        `#${state.head}  hashrate ${formatHashrate(status.hashrate)}  ` +
        `mined by you since #${state.startHeight}: ${mined}  ` +
        `balance ${formatEther(status.balance)} ETH (change ${change >= 0n ? "+" : ""}${formatEther(change)})`;

      events.forEach(print);
      if (tty) process.stdout.write(`${CLEAR_LINE}${statusLine}`);
      else if (state.head !== previousHead || events.length)
        console.log(statusLine);
    } catch (error) {
      failures++;
      print(
        `connection lost (${errorText(error)}), retrying in ${backoff(failures) / 1000}s`,
      );
      if (tty && statusLine) process.stdout.write(`${CLEAR_LINE}${statusLine}`);
    }
  };

  const aborted = new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );

  while (!signal.aborted) {
    // A poll hung on a dead node must not hold up Ctrl-C.
    await Promise.race([step(), aborted]);
    if (signal.aborted) break;
    try {
      await sleep(failures ? backoff(failures) : POLL_MS, signal);
    } catch (error) {
      if (signal.aborted) break;
      throw error;
    }
  }
  if (tty) process.stdout.write(CLEAR_LINE);
}
