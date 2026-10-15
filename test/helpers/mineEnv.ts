import { expect, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

export const ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const OTHER = "0x3c9b08645c616ae3966252f276aa23825b3dcd85";
export const ETH = 10n ** 18n;

export interface FakeBlock {
  number: number;
  hash: string;
  parentHash: string;
  miner: string;
  timestamp: number;
  difficulty: bigint;
}

// The three ways a node says "no such method", as ethers hands them over.
export const unsupported = {
  geth: () =>
    Object.assign(new Error("unsupported operation"), {
      code: "UNSUPPORTED_OPERATION",
    }),
  edr: () =>
    Object.assign(new Error("could not coalesce error"), {
      code: "UNKNOWN_ERROR",
      error: { code: -32004, message: "Method is not supported" },
    }),
  spec: () =>
    Object.assign(new Error("could not coalesce error"), {
      code: "UNKNOWN_ERROR",
      error: { code: -32601, message: "Method not found" },
    }),
};

export const connectionError = () =>
  Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8585"), {
    code: "ECONNREFUSED",
    shortMessage: "connect ECONNREFUSED 127.0.0.1:8585",
  });

/**
 * The scripted node every fake provider reads from. A value that is a
 * function is an error factory: the call throws what it returns. `down`
 * makes every call fail, `hang` makes every call never settle.
 */
export let node: {
  rpc: Record<string, unknown>;
  chain: FakeBlock[];
  balance: (blockNumber: number) => bigint;
  down?: () => Error;
  hang?: boolean;
};
export let sent: [string, unknown[]][];

export function extend(count: number, miner: string, tag = "a") {
  for (let i = 0; i < count; i++) {
    const parent = node.chain[node.chain.length - 1];
    const number = parent ? parent.number + 1 : 0;
    node.chain.push({
      number,
      hash: `0x${tag}${number}`,
      parentHash: parent ? parent.hash : "0x0",
      miner,
      timestamp: 1_700_000_000 + number * 13,
      difficulty: 131072n,
    });
  }
}

export class FakeProvider {
  private check() {
    if (node.hang) return new Promise<never>(() => {});
    if (node.down) throw node.down();
  }
  send = async (method: string, params: unknown[]) => {
    sent.push([method, params]);
    await this.check();
    const value = node.rpc[method];
    if (typeof value === "function") throw value();
    return value;
  };
  getBlock = async (tag: "latest" | number) => {
    await this.check();
    return tag === "latest"
      ? node.chain[node.chain.length - 1]
      : node.chain[tag];
  };
  getBalance = async (_address: string, blockNumber: number) => {
    await this.check();
    return node.balance(blockNumber);
  };
}

export let tmpDir: string;
export let log: ReturnType<typeof vi.spyOn>;
export let ttyDescriptor: PropertyDescriptor | undefined;

export const output = () =>
  log.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");

export function mineSetUp(): void {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-mine-"));
  vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  // Keeps .cmu-networks.json out of the developer's real home directory.
  vi.stubEnv("HOME", tmpDir);
  vi.stubEnv("USERPROFILE", tmpDir);
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  fs.writeFileSync(
    path.join(tmpDir, ".cmu-session"),
    JSON.stringify({ address: ADDRESS, activeNetwork: "local" }),
  );
  // A networks file from before symbols (#228), so amounts read ETH; a fresh
  // seed would label local CMU. writeNetworksFile() swaps it per test.
  writeNetworksFile([{ name: "local", rpcUrl: "http://127.0.0.1:8585" }]);
  // Non-TTY output path: one line per event, no redraw.
  ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", {
    value: false,
    configurable: true,
  });

  sent = [];
  node = {
    rpc: {
      eth_mining: false,
      eth_hashrate: "0x0",
      eth_coinbase: ADDRESS.toLowerCase(),
      miner_setEtherbase: true,
      miner_start: null,
      miner_stop: null,
    },
    chain: [],
    balance: () => 0n,
  };
  extend(11, OTHER); // #0..#10

  vi.doMock("ethers", async (importOriginal) => {
    const real = await importOriginal<typeof import("ethers")>();
    return {
      ...real,
      ethers: { ...real.ethers, JsonRpcProvider: FakeProvider },
    };
  });
}

/** Replaces ~/.cmu-networks.json (HOME is tmpDir). */
export function writeNetworksFile(networks: object[]): void {
  fs.writeFileSync(
    path.join(tmpDir, ".cmu-networks.json"),
    JSON.stringify(networks),
  );
}

export function mineTearDown(): void {
  if (ttyDescriptor)
    Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("ethers");
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

export async function run(...args: string[]) {
  const { mineCommand } = await import("../../src/commands/mine");
  await mineCommand.parseAsync(args, { from: "user" });
}

/** Runs a command that is expected to fail, returning what it printed. */
export async function runFailing(...args: string[]) {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exited");
  }) as any);
  await expect(run(...args)).rejects.toThrow("exited");
  expect(exit).toHaveBeenCalledWith(1);
  return error.mock.calls.flat().join("\n");
}

export const minerCalls = () => sent.filter(([m]) => m.startsWith("miner_"));
