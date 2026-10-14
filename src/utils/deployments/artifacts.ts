import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import * as path from "path";
import { CONTRACT_NAME_PATTERN, type DeploymentRecord, HINT } from "./records";

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
