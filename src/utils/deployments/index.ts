import * as path from "path";
import { RECORD_FORMAT, networkDir, writeRecord } from "./records";
import { loadArtifactBytecodes, matchArtifact } from "./artifacts";

/**
 * Per-network deployment records: deployments/<network>/<Contract>.json.
 *
 * The deploy scripts run as child processes with inherited stdio, so they
 * cannot hand anything back to `cmu deploy`. Instead the parent reads the
 * chain itself: it notes the head block and the deployer's nonce before the
 * scripts run, then scans the blocks they produced for contract creations sent
 * by the deployer, and names each one by matching its creation input against
 * the compiled artifacts. That covers hand-written scripts too, with no
 * cooperation from them.
 *
 * Not seen: contracts created by another contract (a factory - the
 * transaction's `to` is the factory, not null), anything deployed with a key
 * other than the injected PRIVATE_KEY, and contracts whose artifact still has
 * unlinked library placeholders (its bytecode is then not a prefix of the
 * linked input). The last kind is listed as unrecognised rather than dropped.
 */

/**
 * The most blocks one deploy run will scan. Far beyond any local devnet run
 * (one block per transaction); on a busy shared chain a run that outlasts it
 * goes unrecorded with a warning rather than hammering the RPC.
 */
export const MAX_SCAN_BLOCKS = 1000;

/** How long the pre-deploy chain check waits before recording is given up. */
const CHAIN_TIMEOUT_MS = 3000;

const WARNING = "\x1b[33mwarning:\x1b[0m";

/** A contract creation found on-chain, before it is matched to a name. */
export interface FoundCreation {
  address: string;
  txHash: string;
  blockNumber: number;
  timestamp: string;
  codeHash: string;
  /** The creation input: the bytecode followed by the constructor args. */
  data: string;
}

/**
 * Finds the contracts `deployer` created in a block range.
 *
 * Stops as soon as it has seen `expected` transactions from the deployer (the
 * nonce delta), so a run that finished early in the range does not cost a
 * scan of the rest. Transactions from anyone else are ignored, which is what
 * keeps a shared chain's other traffic out of the records.
 *
 * @param {any} provider - An ethers provider.
 * @param {string} deployer - The address whose creations to find.
 * @param {number} fromBlock - First block to scan.
 * @param {number} toBlock - Last block to scan, inclusive.
 * @param {number} expected - Transactions the deployer sent in the range.
 * @returns {Promise<FoundCreation[]>} The creations, in chain order.
 */
export async function scanDeployments(
  provider: any,
  deployer: string,
  fromBlock: number,
  toBlock: number,
  expected: number,
): Promise<FoundCreation[]> {
  const { keccak256 } = await import("ethers");
  const from = deployer.toLowerCase();
  const found: FoundCreation[] = [];
  let seen = 0;

  for (let n = fromBlock; n <= toBlock && seen < expected; n++) {
    const block = await provider.getBlock(n, true);
    if (!block) continue;
    for (const tx of block.prefetchedTransactions ?? []) {
      if (tx.from?.toLowerCase() !== from) continue;
      seen++;
      if (tx.to != null) continue;

      const receipt = await provider.getTransactionReceipt(tx.hash);
      if (!receipt?.contractAddress || receipt.status !== 1) continue;
      const code = await provider.getCode(receipt.contractAddress);
      // A constructor that self-destructed leaves nothing to record.
      if (!code || code === "0x") continue;

      found.push({
        address: receipt.contractAddress,
        txHash: tx.hash,
        blockNumber: block.number,
        timestamp: new Date(block.timestamp * 1000).toISOString(),
        codeHash: keccak256(code),
        data: tx.data,
      });
    }
  }
  return found;
}

/**
 * Starts recording a deploy run: checks the chain and notes where it stands.
 *
 * Never throws. Recording is a side effect of the deploy, never a reason to
 * stop one, so anything that prevents it is a warning and the run goes ahead
 * unrecorded.
 *
 * @param {object} network - The resolved network: name, url, configured chainId.
 * @param {string} deployer - Address of the injected PRIVATE_KEY.
 * @param {string} [cwd] - The project root.
 * @returns {Promise<{ finish: () => Promise<void> } | undefined>} A handle
 *   whose finish() scans, writes and prints the summary; undefined when
 *   recording is off for this run.
 */
export async function startRecording(
  network: { name: string; url: string; chainId?: number },
  deployer: string,
  cwd = process.cwd(),
): Promise<{ finish: () => Promise<void> } | undefined> {
  const { ethers } = await import("ethers");
  const provider = new ethers.JsonRpcProvider(network.url, undefined, {
    staticNetwork: true,
  });

  let dir: string;
  let chainId: number;
  let fromBlock: number;
  let nonceBefore: number;
  try {
    dir = await networkDir(cwd, network.name);
    // Raced like pingNetwork(): ethers retries an unreachable endpoint forever.
    const live: any = await Promise.race([
      provider.getNetwork(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`${network.url} did not answer`)),
          CHAIN_TIMEOUT_MS,
        ),
      ),
    ]);
    chainId = Number(live.chainId);
    // The record is keyed by network name, so a config whose chainId is not
    // the chain's would file this chain's contracts under the wrong network.
    if (network.chainId != null && Number(network.chainId) !== chainId) {
      throw new Error(
        `'${network.name}' is configured as chain ${network.chainId}, but ${network.url} is chain ${chainId}`,
      );
    }
    fromBlock = (await provider.getBlockNumber()) + 1;
    nonceBefore = await provider.getTransactionCount(deployer);
  } catch (error) {
    provider.destroy();
    console.warn(
      `${WARNING} deployment records are off for this run: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }

  return {
    async finish() {
      try {
        const toBlock = await provider.getBlockNumber();
        const expected =
          (await provider.getTransactionCount(deployer)) - nonceBefore;
        if (expected > 0 && toBlock - fromBlock + 1 > MAX_SCAN_BLOCKS) {
          console.warn(
            `${WARNING} the deploy spanned ${toBlock - fromBlock + 1} blocks, more than the ${MAX_SCAN_BLOCKS} scanned; nothing was recorded.`,
          );
          return;
        }
        const found =
          expected > 0
            ? await scanDeployments(
                provider,
                deployer,
                fromBlock,
                toBlock,
                expected,
              )
            : [];
        await recordAndSummarise(found, {
          cwd,
          dir,
          network: network.name,
          chainId,
          deployer,
        });
      } catch (error) {
        console.warn(
          `${WARNING} could not record the deployments: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        provider.destroy();
      }
    },
  };
}

/**
 * Names the creations, writes one record per contract and prints the summary.
 *
 * @param {FoundCreation[]} found - From scanDeployments().
 * @param {object} ctx - Where and for which network to record.
 * @returns {Promise<void>}
 */
export async function recordAndSummarise(
  found: FoundCreation[],
  ctx: {
    cwd: string;
    dir: string;
    network: string;
    chainId: number;
    deployer: string;
  },
): Promise<void> {
  if (found.length === 0) {
    console.log(`\nNo contract creations from ${ctx.deployer} detected.`);
    return;
  }

  const artifacts = await loadArtifactBytecodes(ctx.cwd);
  const named = found.map((f) => ({
    ...f,
    ...matchArtifact(f.data, artifacts),
  }));

  // A contract deployed twice in one run keeps only its last instance.
  const last = new Map<string, (typeof named)[number]>();
  for (const n of named) if (n.name) last.set(n.name, n);

  const written = new Map<string, string>();
  for (const [name, n] of last) {
    const count = named.filter((m) => m.name === name).length;
    if (count > 1) {
      console.warn(
        `${WARNING} ${name} was deployed ${count} times; the record keeps the last one (${n.address}).`,
      );
    }
    try {
      const file = await writeRecord(ctx.dir, {
        format: RECORD_FORMAT,
        contract: name,
        network: ctx.network,
        chainId: ctx.chainId,
        address: n.address,
        deployer: ctx.deployer,
        txHash: n.txHash,
        blockNumber: n.blockNumber,
        timestamp: n.timestamp,
        codeHash: n.codeHash,
      });
      written.set(n.txHash, path.relative(ctx.cwd, file));
    } catch (error) {
      console.warn(
        `${WARNING} ${name} was not recorded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(`\n--- Deployed on '${ctx.network}' (chain ${ctx.chainId}) ---`);
  for (const n of named) {
    const label = n.name ?? (n.ambiguous ? "(ambiguous)" : "(unrecognised)");
    const where = written.get(n.txHash);
    const note = where
      ? `-> ${where}`
      : n.ambiguous
        ? `creation code matches ${n.ambiguous.join(", ")}; not recorded`
        : n.name
          ? "not recorded"
          : "no artifact matches its creation code";
    console.log(`${label}  ${n.address}  block ${n.blockNumber}  ${note}`);
  }
  console.log("-".repeat(40));
}

export {
  RECORD_FORMAT,
  findRecordsByAddress,
  networkDir,
  readRecord,
  writeRecord,
} from "./records";
export type { DeploymentRecord } from "./records";
export {
  codeMatchesArtifact,
  loadArtifactBytecodes,
  matchArtifact,
  verifyDeployed,
} from "./artifacts";
export type { ArtifactBytecode } from "./artifacts";
