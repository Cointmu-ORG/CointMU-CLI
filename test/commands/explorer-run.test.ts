import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256 } from "ethers";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { encryptSessionKey } from "../../src/utils/session";
import { TEST_PBKDF2_ITERATIONS } from "../helpers/testPbkdf2";
import { PRIVATE_KEY, SESSION_PASSWORD, ADDRESS } from "../helpers/explorerEnv";

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
        ...encryptSessionKey(
          SESSION_PASSWORD,
          PRIVATE_KEY,
          TEST_PBKDF2_ITERATIONS,
        ),
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
      keccak256: actual.keccak256,
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

  it("labels an address from this network's records only", async () => {
    writeConfig();
    for (const network of ["local", "kampus"]) {
      const dir = path.join(tmpDir, "deployments", network);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `${network === "local" ? "Token" : "Other"}.json`),
        JSON.stringify({
          format: 1,
          contract: network === "local" ? "Token" : "Other",
          network,
          chainId: 1912,
          address: ADDRESS.toLowerCase(),
          deployer: ADDRESS,
          txHash: `0x${"11".repeat(32)}`,
          blockNumber: 3,
          timestamp: "2026-10-13T08:00:00.000Z",
          codeHash: keccak256("0x60806040"),
        }),
      );
    }
    // Garbage next to it is skipped, not fatal.
    fs.writeFileSync(
      path.join(tmpDir, "deployments", "local", "Junk.json"),
      "{",
    );
    mockEthers({
      getCode: async () => "0x60806040",
      getBalance: async () => 0n,
    });

    await expect(
      run({ contract: ADDRESS, yes: true }),
    ).resolves.toBeUndefined();

    const printed = vi.mocked(console.log).mock.calls.join("\n");
    expect(printed).toContain(
      `Recorded as  : Token (${path.join("deployments", "local", "Token.json")}, recorded 2026-10-13T08:00:00.000Z)`,
    );
    expect(printed).toContain("Record check : code matches the record");
    expect(printed).not.toContain("Other");
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

  // Issue #228: the balance unit comes from networks.<name>.symbol.
  describe("balance symbol", () => {
    function writeLocalConfig(fields: string): void {
      fs.writeFileSync(
        path.join(tmpDir, "cmu.config.js"),
        `module.exports = { defaultNetwork: "local", networks: { local: ` +
          `{ url: "http://127.0.0.1:8585", chainId: 1912${fields} } } };`,
      );
    }

    async function printedBalance(): Promise<string> {
      mockEthers({
        getCode: async () => "0x",
        getBalance: async () => 10n ** 18n,
      });
      await run({ contract: ADDRESS, yes: true });
      const printed = vi.mocked(console.log).mock.calls.join("\n");
      return printed.split("\n").find((l) => l.startsWith("Balance")) ?? "";
    }

    it("uses the symbol set in cmu.config", async () => {
      writeLocalConfig(`, symbol: "CMU"`);

      expect(await printedBalance()).toBe(
        "Balance      : 1.0 CMU (1000000000000000000 wei)",
      );
    });

    it("falls back to ETH for a config without one", async () => {
      writeLocalConfig("");

      expect(await printedBalance()).toBe(
        "Balance      : 1.0 ETH (1000000000000000000 wei)",
      );
    });

    it("uses CMU for the built-in local devnet when there is no config", async () => {
      expect(await printedBalance()).toBe(
        "Balance      : 1.0 CMU (1000000000000000000 wei)",
      );
    });

    it("refuses an invalid symbol in cmu.config, naming the key", async () => {
      writeLocalConfig(`, symbol: "C-M"`);
      mockEthers({
        getNetwork: async () => {
          throw new Error("must not connect");
        },
      });

      await expect(run({ contract: ADDRESS, yes: true })).rejects.toThrow(
        /invalid symbol "C-M"[\s\S]*networks\.local\.symbol in cmu\.config\.js/,
      );
    });
  });
});
