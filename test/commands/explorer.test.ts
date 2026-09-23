import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "ethers";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { encryptSessionKey } from "../../src/utils/session";
import {
  explorerCommand,
  formatBlock,
  formatContract,
  parseBlockNumber,
} from "../../src/commands/explorer";

// No real RPC anywhere in this file. The pure halves (parsing, formatting) run
// directly, and the one path that needs a node - a block that does not exist -
// gets a stubbed ethers instead, the way deploy.test.ts stubs it.

// well-known Ganache test key — never fund this
const PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SESSION_PASSWORD = "correct horse";
const ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

describe("parseBlockNumber", () => {
  it("accepts non-negative decimal integers", () => {
    expect(parseBlockNumber("0")).toBe(0);
    expect(parseBlockNumber("42")).toBe(42);
    expect(parseBlockNumber(" 7 ")).toBe(7);
  });

  it("rejects everything that is not one", () => {
    for (const bad of ["", "-1", "1.5", "abc", "0x2a", "1e3", "9".repeat(20)]) {
      expect(() => parseBlockNumber(bad)).toThrow(/not a valid block number/);
    }
  });
});

describe("formatBlock", () => {
  // Only the fields formatBlock reads; the rest of an ethers Block is not
  // needed to print one.
  const block = {
    number: 42,
    hash: "0xaaa",
    parentHash: "0xbbb",
    timestamp: 1758448800,
    transactions: ["0x1", "0x2", "0x3"],
    gasUsed: 210000n,
    gasLimit: 30000000n,
    miner: "0xccc",
  } as unknown as Block;

  it("prints the readable timestamp, the count and the gas ratio", () => {
    const out = formatBlock(block, "local");

    expect(out).toContain("Block 42 on 'local'");
    expect(out).toContain("0xaaa");
    expect(out).toContain("0xbbb");
    // The whole point of the conversion: a date, not a bare unix integer.
    expect(out).toContain("2025-09-21T10:00:00.000Z");
    expect(out).toContain("(1758448800)");
    expect(out).toContain("Transactions : 3");
    expect(out).toContain("210000 / 30000000 (0.70%)");
    expect(out).toContain("0xccc");
  });

  it("drops the percentage rather than printing NaN on a zero gas limit", () => {
    const out = formatBlock({ ...block, gasLimit: 0n }, "local");

    expect(out).toContain("210000 / 0");
    expect(out).not.toContain("NaN");
  });
});

describe("formatContract", () => {
  it("says an empty code result is not a contract", () => {
    const out = formatContract(ADDRESS, "0x", 0n, "local");

    expect(out).toMatch(/not a contract/);
    expect(out).toContain("0.0 (0 wei)");
  });

  it("reports the bytecode size and the balance when there is code", () => {
    const out = formatContract(ADDRESS, "0x60806040", 10n ** 18n, "local");

    expect(out).toContain("4 bytes");
    expect(out).toContain("1.0 (1000000000000000000 wei)");
  });
});

describe("runExplorer", () => {
  let tmpDir: string;
  const prevKey = process.env.PRIVATE_KEY;
  const realIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-explorer-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    delete process.env.PRIVATE_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("inquirer");
    vi.doUnmock("ethers");
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.stdin.isTTY = realIsTTY;
    if (prevKey === undefined) delete process.env.PRIVATE_KEY;
    else process.env.PRIVATE_KEY = prevKey;
  });

  function writeConfig(prelude = ""): void {
    fs.writeFileSync(
      path.join(tmpDir, "cmu.config.js"),
      `${prelude}module.exports = { defaultNetwork: "local", ` +
        `networks: { local: { url: "http://127.0.0.1:8585", chainId: 1912 } } };`,
    );
  }

  function writeSessionFile(): void {
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-session"),
      JSON.stringify({
        address: "0xTest",
        activeNetwork: "local",
        ...encryptSessionKey(SESSION_PASSWORD, PRIVATE_KEY),
      }),
    );
  }

  /** A whole ethers module, for the paths that would otherwise need a node. */
  function mockEthers(provider: Record<string, unknown>): void {
    const actual = require("ethers");
    vi.doMock("ethers", () => ({
      ethers: {
        ...actual.ethers,
        JsonRpcProvider: class {
          constructor() {
            return {
              getNetwork: async () => ({ name: "local", chainId: 1912n }),
              destroy: () => {},
              ...provider,
            };
          }
        },
      },
      formatEther: actual.formatEther,
    }));
  }

  async function run(options = {}) {
    const { runExplorer } = await import("../../src/commands/explorer");
    return runExplorer(options);
  }

  it("requires exactly one of --block and --contract", async () => {
    await expect(run()).rejects.toThrow(/exactly one of/);
    await expect(run({ block: "1", contract: ADDRESS })).rejects.toThrow(
      /exactly one of/,
    );
  });

  // Both guards run before confirmProjectTrust, so a malformed flag never
  // makes the user answer a trust prompt for a command that cannot run.
  it("rejects a bad block number and a bad address before the trust gate", async () => {
    const marker = path.join(tmpDir, "executed.txt");
    writeConfig(
      `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`,
    );
    process.stdin.isTTY = false;

    await expect(run({ block: "-1" })).rejects.toThrow(
      /not a valid block number/,
    );
    await expect(run({ contract: "Token" })).rejects.toThrow(
      /not a valid contract address/,
    );
    expect(fs.existsSync(marker)).toBe(false);
  });

  // cmu.config.js is require()d to resolve the network, i.e. arbitrary code
  // execution from the project directory. It must not run before the user has
  // confirmed, exactly as in `cmu console`.
  it("blocks in a non-TTY session and never loads the config", async () => {
    const marker = path.join(tmpDir, "executed.txt");
    writeConfig(
      `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`,
    );
    process.stdin.isTTY = false;

    await expect(run({ block: "0" })).rejects.toThrow(
      /non-interactive session/,
    );
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("fails before any query on a network the config does not define", async () => {
    writeConfig();

    await expect(
      run({ block: "0", network: "mars", yes: true }),
    ).rejects.toThrow(/is not defined/);
  });

  it("reports the chain tip when the block does not exist", async () => {
    writeConfig();
    mockEthers({ getBlock: async () => null, getBlockNumber: async () => 42 });

    await expect(run({ block: "999", yes: true })).rejects.toThrow(
      /block 999 does not exist on 'local'[\s\S]*block 42/,
    );
  });

  it("prints the block it found", async () => {
    writeConfig();
    mockEthers({
      getBlock: async () => ({
        number: 1,
        hash: "0xaaa",
        parentHash: "0xbbb",
        timestamp: 1758448800,
        transactions: [],
        gasUsed: 0n,
        gasLimit: 30000000n,
        miner: "0xccc",
      }),
    });

    await expect(run({ block: "1", yes: true })).resolves.toBeUndefined();
    expect(vi.mocked(console.log).mock.calls.join("\n")).toContain(
      "Block 1 on 'local'",
    );
  });

  it("exits zero on an address that holds no contract", async () => {
    writeConfig();
    mockEthers({
      getCode: async () => "0x",
      getBalance: async () => 0n,
    });

    await expect(
      run({ contract: ADDRESS, yes: true }),
    ).resolves.toBeUndefined();
    expect(vi.mocked(console.log).mock.calls.join("\n")).toMatch(
      /not a contract/,
    );
  });

  it("surfaces an unreachable endpoint instead of a raw RPC error", async () => {
    writeConfig();
    mockEthers({
      getNetwork: () => new Promise(() => {}),
    });

    await expect(run({ block: "0", yes: true })).rejects.toThrow(
      /is unreachable/,
    );
  }, 20000);

  it("never asks for the session password", async () => {
    writeConfig();
    writeSessionFile();
    mockEthers({ getCode: async () => "0x", getBalance: async () => 0n });
    vi.doMock("inquirer", () => ({
      default: {
        prompt: async () => {
          throw new Error("inquirer.prompt should not be called");
        },
      },
    }));

    // Resolving (instead of throwing from the mocked prompt) proves no prompt.
    await expect(
      run({ contract: ADDRESS, yes: true }),
    ).resolves.toBeUndefined();
  });
});

describe("explorerCommand", () => {
  it("offers both lookups alongside --network", () => {
    const flags = explorerCommand.options.map((option) => option.flags);

    expect(explorerCommand.name()).toBe("explorer");
    expect(flags).toContain("-b, --block <number>");
    expect(flags).toContain("-c, --contract <address>");
    expect(flags).toContain("-n, --network <name>");
    expect(flags).toContain("-y, --yes");
  });
});
