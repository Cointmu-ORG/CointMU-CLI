import { describe, expect, it } from "vitest";
import { keccak256, type Block } from "ethers";
import {
  explorerCommand,
  formatBlock,
  formatContract,
  parseBlockNumber,
} from "../../src/commands/explorer";
import { ADDRESS } from "../helpers/explorerEnv";

// No real RPC anywhere in this file. The pure halves (parsing, formatting) run
// directly, and the one path that needs a node - a block that does not exist -
// gets a stubbed ethers instead, the way deploy.test.ts stubs it.

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
  const LOCAL = { name: "local", symbol: "ETH" };

  it("says an empty code result is not a contract", () => {
    const out = formatContract(ADDRESS, "0x", 0n, LOCAL);

    expect(out).toMatch(/not a contract/);
    expect(out).toContain("0.0 ETH (0 wei)");
  });

  it("reports the bytecode size and the balance when there is code", () => {
    const out = formatContract(ADDRESS, "0x60806040", 10n ** 18n, LOCAL);

    expect(out).toContain("4 bytes");
    expect(out).toContain("1.0 ETH (1000000000000000000 wei)");
  });

  // Issue #228: the unit is the network's symbol.
  it("labels the balance with the network's symbol", () => {
    const out = formatContract(ADDRESS, "0x", 10n ** 18n, {
      name: "local",
      symbol: "CMU",
    });

    expect(out).toContain("Balance      : 1.0 CMU (1000000000000000000 wei)");
  });

  const record = (code: string) => ({
    record: {
      format: 1,
      contract: "Token",
      network: "local",
      chainId: 1912,
      address: ADDRESS,
      deployer: ADDRESS,
      txHash: `0x${"11".repeat(32)}`,
      blockNumber: 3,
      timestamp: "2026-10-13T08:00:00.000Z",
      codeHash: keccak256(code),
    },
    file: "deployments/local/Token.json",
  });

  it("names an address a record matches, with the code check", () => {
    const out = formatContract(ADDRESS, "0x60806040", 0n, LOCAL, [
      record("0x60806040"),
    ]);

    expect(out).toContain(
      "Recorded as  : Token (deployments/local/Token.json, recorded 2026-10-13T08:00:00.000Z)\n" +
        "Record check : code matches the record\n",
    );
  });

  it("adds nothing for an address no record names", () => {
    expect(formatContract(ADDRESS, "0x60806040", 0n, LOCAL, [])).not.toMatch(
      /Recorded as|Record check/,
    );
  });

  // Read-only: a stale record is labelled, not refused.
  it("marks a stale record instead of refusing", () => {
    expect(
      formatContract(ADDRESS, "0x6001", 0n, LOCAL, [record("0x60806040")]),
    ).toContain(
      "Record check : code differs from the record - the record is stale",
    );
    expect(
      formatContract(ADDRESS, "0x", 0n, LOCAL, [record("0x60806040")]),
    ).toContain("Record check : no code at the address - the record is stale");
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
