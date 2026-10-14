import { randomBytes } from "crypto";
import { existsSync } from "fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "fs/promises";
import * as path from "path";

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

/** Bumped when the record shape changes; a newer one is never overwritten. */
export const RECORD_FORMAT = 1;

/**
 * The most blocks one deploy run will scan. Far beyond any local devnet run
 * (one block per transaction); on a busy shared chain a run that outlasts it
 * goes unrecorded with a warning rather than hammering the RPC.
 */
export const MAX_SCAN_BLOCKS = 1000;

/** How long the pre-deploy chain check waits before recording is given up. */
const CHAIN_TIMEOUT_MS = 3000;

/** The network name becomes a directory name, so it is held to a safe set. */
const NETWORK_DIR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Device names Windows will not create a directory under, in any case. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** A Solidity identifier, which is all compile.ts ever names an artifact. */
const CONTRACT_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const WARNING = "\x1b[33mwarning:\x1b[0m";

export interface DeploymentRecord {
  format: number;
  contract: string;
  network: string;
  chainId: number;
  address: string;
  deployer: string;
  txHash: string;
  blockNumber: number;
  /** ISO time of the block the creation was mined in. */
  timestamp: string;
  /** keccak256 of the runtime code at `address` when it was recorded. */
  codeHash: string;
}

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
 * Resolves, and checks, the directory a network's records live in.
 *
 * Two network names that differ only in case would share one directory on a
 * case-insensitive filesystem (Windows, default macOS), mixing two networks'
 * records, so an existing directory spelled differently is a collision.
 *
 * @param {string} cwd - The project root.
 * @param {string} network - The network name.
 * @returns {Promise<string>} The absolute directory path.
 * @throws {Error} When the name is unsafe as a directory or collides.
 */
export async function networkDir(
  cwd: string,
  network: string,
): Promise<string> {
  if (!NETWORK_DIR_PATTERN.test(network) || WINDOWS_RESERVED.test(network)) {
    throw new Error(
      `network name '${network}' cannot be used as a deployments/ directory.\n` +
        "\x1b[2mhint:\x1b[0m use letters, digits, '-' and '_' only, and not a Windows device name (con, nul, com1, ...).",
    );
  }

  const root = path.join(cwd, "deployments");
  const entries = existsSync(root) ? await readdir(root) : [];
  const clash = entries.find(
    (e) => e !== network && e.toLowerCase() === network.toLowerCase(),
  );
  if (clash) {
    throw new Error(
      `network '${network}' collides with the existing deployments/${clash}/ on a case-insensitive filesystem.\n` +
        "\x1b[2mhint:\x1b[0m rename one of the two networks in cmu.config.ts so they differ by more than case.",
    );
  }

  return path.join(root, network);
}

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
 * Writes one record atomically: a temp file in the same directory, then a
 * rename, so a reader - or a second `cmu deploy` writing the same contract -
 * never sees half a file. The last rename wins, and both writers' records are
 * whole.
 *
 * @param {string} dir - The network's directory, from networkDir().
 * @param {DeploymentRecord} record - The record to write.
 * @returns {Promise<string>} The path written.
 * @throws {Error} When an existing record is a newer format, or the write fails.
 */
export async function writeRecord(
  dir: string,
  record: DeploymentRecord,
): Promise<string> {
  const file = path.join(dir, `${record.contract}.json`);

  if (existsSync(file)) {
    let format: unknown;
    try {
      format = JSON.parse(await readFile(file, "utf8")).format;
    } catch {
      // Unreadable: nothing in it worth keeping over a fresh record.
    }
    if (typeof format === "number" && format > RECORD_FORMAT) {
      throw new Error(
        `${file} is record format ${format}, newer than this cmu writes (${RECORD_FORMAT}); left as is.\n` +
          "\x1b[2mhint:\x1b[0m update cmu with `cmu update`.",
      );
    }
  }

  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  return file;
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

const HINT = "\x1b[2mhint:\x1b[0m";

/**
 * A parsed record holds every field with the right shape. Records in a cloned
 * repository are data someone else wrote, so nothing is assumed of them.
 *
 * @param {any} r - The parsed JSON.
 * @returns {boolean} Whether it is a usable format-1 record.
 */
function isRecord(r: any): r is DeploymentRecord {
  return (
    r?.format === RECORD_FORMAT &&
    typeof r.contract === "string" &&
    typeof r.network === "string" &&
    Number.isSafeInteger(r.chainId) &&
    /^0x[0-9a-fA-F]{40}$/.test(r.address) &&
    /^0x[0-9a-fA-F]{64}$/.test(r.codeHash) &&
    typeof r.timestamp === "string"
  );
}

/**
 * Reads a contract's record for one network.
 *
 * Never falls back to the flat deployments/<Contract>.json older scaffolds
 * wrote: it is not per network, so it could name a contract on another chain
 * (#131). Its presence only changes the hint.
 *
 * @param {string} cwd - The project root.
 * @param {string} network - The network the console is on.
 * @param {string} name - The contract name.
 * @returns {Promise<{ record: DeploymentRecord, file: string }>} The record
 *   and its path relative to cwd.
 * @throws {Error} When there is no usable record.
 */
export async function readRecord(
  cwd: string,
  network: string,
  name: string,
): Promise<{ record: DeploymentRecord; file: string }> {
  if (!CONTRACT_NAME_PATTERN.test(name)) {
    throw new Error(
      `'${name}' is not a contract name.\n` +
        `${HINT} pass the name \`cmu compile\` wrote to artifacts/<Name>.json.`,
    );
  }

  const file = path.join(await networkDir(cwd, network), `${name}.json`);
  const shown = path.relative(cwd, file);

  if (!existsSync(file)) {
    const legacy = path.join(cwd, "deployments", `${name}.json`);
    throw new Error(
      `no deployment record for '${name}' on '${network}' (${shown}).\n` +
        (existsSync(legacy)
          ? `${HINT} deployments/${name}.json is from an older scaffold and is not read; run \`cmu deploy\` to record ${name} on '${network}'.`
          : `${HINT} run \`cmu deploy\` to deploy and record it on '${network}', or pick the network it was deployed to with -n.`),
    );
  }

  let record: any;
  try {
    record = JSON.parse(await readFile(file, "utf8"));
  } catch {
    // Unreadable and malformed share the message below.
  }
  if (typeof record?.format === "number" && record.format > RECORD_FORMAT) {
    throw new Error(
      `${shown} is record format ${record.format}, newer than this cmu reads (${RECORD_FORMAT}).\n` +
        `${HINT} update cmu with \`cmu update\`.`,
    );
  }
  // A record copied in from another network's directory, or renamed, names
  // something other than what its path says.
  if (
    !isRecord(record) ||
    record.contract !== name ||
    record.network !== network
  ) {
    throw new Error(
      `${shown} is not a usable deployment record.\n` +
        `${HINT} delete it and run \`cmu deploy\` again.`,
    );
  }

  return { record, file: shown };
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

/**
 * Every usable record on a network that names `address`. Read-only callers
 * (the explorer) use this to label an address, so anything unreadable - a bad
 * network name, a malformed or newer record - is skipped, never an error.
 *
 * @param {string} cwd - The project root.
 * @param {string} network - The network name.
 * @param {string} address - The address to look up.
 * @returns {Promise<{ record: DeploymentRecord, file: string }[]>} Matches.
 */
export async function findRecordsByAddress(
  cwd: string,
  network: string,
  address: string,
): Promise<{ record: DeploymentRecord; file: string }[]> {
  let dir: string;
  try {
    dir = await networkDir(cwd, network);
  } catch {
    return [];
  }
  if (!existsSync(dir)) return [];

  const out: { record: DeploymentRecord; file: string }[] = [];
  for (const entry of await readdir(dir)) {
    if (!entry.endsWith(".json")) continue;
    const file = path.join(dir, entry);
    try {
      const record = JSON.parse(await readFile(file, "utf8"));
      if (
        isRecord(record) &&
        record.network === network &&
        record.address.toLowerCase() === address.toLowerCase()
      ) {
        out.push({ record, file: path.relative(cwd, file) });
      }
    } catch {
      // Not a record; nothing to label the address with.
    }
  }
  return out;
}
