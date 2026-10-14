import { randomBytes } from "crypto";
import { existsSync } from "fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "fs/promises";
import * as path from "path";

/** Bumped when the record shape changes; a newer one is never overwritten. */
export const RECORD_FORMAT = 1;

/** The network name becomes a directory name, so it is held to a safe set. */
const NETWORK_DIR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Device names Windows will not create a directory under, in any case. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** A Solidity identifier, which is all compile.ts ever names an artifact. */
export const CONTRACT_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

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

export const HINT = "\x1b[2mhint:\x1b[0m";

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
