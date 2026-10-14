import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import * as path from "path";
import {
  RECORD_FORMAT,
  CONTRACT_NAME_PATTERN,
  type DeploymentRecord,
  networkDir,
  writeRecord,
  HINT,
} from "./records";

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

/** Creation bytecode of one artifact, lowercased and without 0x. */
export interface ArtifactBytecode {
  name: string;
  bytecode: string;
}

const strip0x = (hex: string) => hex.toLowerCase().replace(/^0x/, "");

/**
 * Reads the creation bytecode of every artifact in artifacts/.
 *
 * Artifacts with no bytecode (interfaces, abstract contracts) are left out:
 * an empty prefix matches every creation input.
 *
 * @param {string} cwd - The project root.
 * @returns {Promise<ArtifactBytecode[]>} One entry per deployable artifact.
 */
export async function loadArtifactBytecodes(
  cwd: string,
): Promise<ArtifactBytecode[]> {
  const dir = path.join(cwd, "artifacts");
  if (!existsSync(dir)) return [];

  const out: ArtifactBytecode[] = [];
  for (const file of await readdir(dir)) {
    const name = path.basename(file, ".json");
    if (!file.endsWith(".json") || !CONTRACT_NAME_PATTERN.test(name)) continue;
    try {
      const artifact = JSON.parse(await readFile(path.join(dir, file), "utf8"));
      // The same fallback the scaffolded deploy script reads.
      const bytecode = strip0x(
        artifact.evm?.bytecode?.object || artifact.bytecode || "",
      );
      if (bytecode) out.push({ name, bytecode });
    } catch {
      // Not an artifact cmu compile wrote; nothing to match against.
    }
  }
  return out;
}

/**
 * Names a creation by the artifact whose bytecode its input starts with.
 *
 * The longest match wins, so a contract whose bytecode happens to begin with
 * another's is not mistaken for it. A tie names nothing.
 *
 * @param {string} data - The creation transaction's input.
 * @param {ArtifactBytecode[]} artifacts - From loadArtifactBytecodes().
 * @returns {{ name?: string, ambiguous?: string[] }} The match, if any.
 */
export function matchArtifact(
  data: string,
  artifacts: ArtifactBytecode[],
): { name?: string; ambiguous?: string[] } {
  const input = strip0x(data);
  const hits = artifacts.filter((a) => input.startsWith(a.bytecode));
  if (hits.length === 0) return {};

  const longest = Math.max(...hits.map((h) => h.bytecode.length));
  const best = hits.filter((h) => h.bytecode.length === longest);
  return best.length === 1
    ? { name: best[0].name }
    : { ambiguous: best.map((b) => b.name) };
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

/**
 * The runtime bytecode compile.ts wrote for a contract, with the byte ranges
 * solc leaves for immutables.
 *
 * @param {string} cwd - The project root.
 * @param {string} name - The contract name.
 * @returns {Promise<{ object: string, immutables: { start: number, length: number }[] }>}
 * @throws {Error} When the artifact has no runtime bytecode, or links libraries.
 */
async function loadRuntimeBytecode(
  cwd: string,
  name: string,
): Promise<{
  object: string;
  immutables: { start: number; length: number }[];
}> {
  let deployed: any;
  try {
    const artifact = JSON.parse(
      await readFile(path.join(cwd, "artifacts", `${name}.json`), "utf8"),
    );
    deployed = artifact.evm?.deployedBytecode;
  } catch {
    // Missing or unreadable: the same fix as an artifact from an older cmu.
  }
  if (typeof deployed?.object !== "string" || !deployed.object) {
    throw new Error(
      `artifacts/${name}.json has no deployed bytecode to check the contract against.\n` +
        `${HINT} run \`cmu compile\`.`,
    );
  }
  // ponytail: linked libraries are refused rather than verified. Upgrade path:
  // compare with each placeholder's 20 bytes masked, like the immutables.
  if (deployed.object.includes("__$")) {
    throw new Error(
      `${name} links libraries, so its deployed code cannot be checked against artifacts/${name}.json.\n` +
        `${HINT} getDeployed() does not support contracts with linked libraries yet.`,
    );
  }
  const immutables = Object.values(deployed.immutableReferences ?? {}).flat();
  return { object: strip0x(deployed.object), immutables: immutables as any };
}

/**
 * Whether on-chain runtime code is what the artifact compiles to.
 *
 * Immutables are written into the runtime code by the constructor, so their
 * ranges are masked on both sides. A range is only honoured as solc emits it -
 * 32 bytes, all zero in the artifact - so an artifact cannot declare the whole
 * contract "immutable" and match anything.
 *
 * @param {string} code - eth_getCode at the address.
 * @param {string} object - The artifact's runtime bytecode, without 0x.
 * @param {{ start: number, length: number }[]} immutables - Byte ranges.
 * @returns {boolean} True when the two agree outside the immutables.
 */
export function codeMatchesArtifact(
  code: string,
  object: string,
  immutables: { start: number; length: number }[],
): boolean {
  let onChain = strip0x(code);
  let compiled = strip0x(object);
  if (onChain.length !== compiled.length) return false;

  for (const { start, length } of immutables) {
    const from = start * 2;
    const to = from + length * 2;
    if (
      !Number.isSafeInteger(start) ||
      length !== 32 ||
      to > compiled.length ||
      !/^0*$/.test(compiled.slice(from, to))
    ) {
      return false;
    }
    const zeros = "0".repeat(to - from);
    onChain = onChain.slice(0, from) + zeros + onChain.slice(to);
    compiled = compiled.slice(0, from) + zeros + compiled.slice(to);
  }
  return onChain === compiled;
}

/**
 * Checks a record against the chain before anything trusts its address.
 *
 * In order: the chain is the one recorded; there is code at the address (a
 * restarted devnet leaves none); it is the code recorded (a restarted devnet
 * can put another contract at the same deployer+nonce address); and it is
 * what the local artifact compiles to, which is what stops a record in a
 * cloned repository from pointing the console at someone else's contract.
 *
 * @param {any} provider - An ethers provider on the record's network.
 * @param {string} cwd - The project root.
 * @param {DeploymentRecord} record - From readRecord().
 * @returns {Promise<void>} Resolves when every check passes.
 * @throws {Error} On the first check that fails.
 */
export async function verifyDeployed(
  provider: any,
  cwd: string,
  record: DeploymentRecord,
): Promise<void> {
  const { keccak256 } = await import("ethers");
  const { contract: name, network, address } = record;

  const live = Number((await provider.getNetwork()).chainId);
  if (live !== record.chainId) {
    throw new Error(
      `the record for ${name} on '${network}' is for chain ${record.chainId}, but '${network}' is chain ${live}.\n` +
        `${HINT} run \`cmu deploy\` again on this network.`,
    );
  }

  const code = await provider.getCode(address);
  if (!code || code === "0x") {
    throw new Error(
      `the record for ${name} on '${network}' is stale: there is no contract at ${address} (was the devnet restarted?).\n` +
        `${HINT} run \`cmu deploy\` again.`,
    );
  }
  if (keccak256(code) !== record.codeHash.toLowerCase()) {
    throw new Error(
      `the record for ${name} on '${network}' is stale: the code at ${address} is not the code that was recorded.\n` +
        `${HINT} run \`cmu deploy\` again.`,
    );
  }

  const { object, immutables } = await loadRuntimeBytecode(cwd, name);
  if (!codeMatchesArtifact(code, object, immutables)) {
    throw new Error(
      `${name} at ${address}: the compiled artifact no longer matches the deployed code (did the source change since the last deploy?).\n` +
        `${HINT} run \`cmu deploy\` again.`,
    );
  }
}

export {
  RECORD_FORMAT,
  findRecordsByAddress,
  networkDir,
  readRecord,
  writeRecord,
} from "./records";
export type { DeploymentRecord } from "./records";
