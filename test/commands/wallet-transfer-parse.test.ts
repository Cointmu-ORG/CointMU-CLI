import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADDRESS_A, setUp, tearDown } from "../helpers/walletEnv";
import { walletCommands } from "../helpers/walletSut";

beforeEach(setUp);
afterEach(tearDown);

// Issue #179: `wallet transfer` moves funds, so its inputs are parsed more
// strictly than ethers does on its own (isAddress takes ICAP and bare hex;
// parseEther takes "-1", "0", "1." and ".5").

describe("transfer recipient parsing", () => {
  const lower = ADDRESS_A.toLowerCase();

  it.each([
    ["too short", "0x123"],
    ["no 0x prefix", ADDRESS_A.slice(2)],
    ["uppercase 0X prefix", `0X${ADDRESS_A.slice(2)}`],
    ["an ICAP address", "XE7338O073KYGTWWZN0F2WZ0R8PX5ZPPZS"],
    ["an ENS name", "vitalik.eth"],
    ["leading space", ` ${ADDRESS_A}`],
    ["trailing newline", `${ADDRESS_A}\n`],
    ["empty", ""],
  ])("rejects %s", async (_, to) => {
    const { parseTransferAddress } = await walletCommands();
    await expect(parseTransferAddress(to)).rejects.toThrow("invalid recipient");
  });

  it("rejects a mixed-case address with a wrong checksum", async () => {
    const { parseTransferAddress } = await walletCommands();
    const typo = ADDRESS_A.replace("C51", "c51");
    await expect(parseTransferAddress(typo)).rejects.toThrow(
      "bad address checksum",
    );
  });

  it.each([
    ["checksummed", ADDRESS_A],
    ["all lowercase", lower],
    ["all uppercase", `0x${ADDRESS_A.slice(2).toUpperCase()}`],
  ])("accepts %s and returns the checksummed form", async (_, to) => {
    const { parseTransferAddress } = await walletCommands();
    await expect(parseTransferAddress(to)).resolves.toBe(ADDRESS_A);
  });
});

describe("transfer amount parsing", () => {
  it.each([
    "0",
    "0.0",
    "000",
    "-1",
    "+1",
    "1e3",
    "0x10",
    "1_000",
    " 1",
    "1 ",
    "1,5",
    "",
    ".",
    "1.",
    ".5",
    "Infinity",
    "NaN",
    "１",
    // An unescaped dot in the pattern would let these through.
    "1x5",
    // An end anchor that matched before a trailing newline would too.
    "1.5\n",
  ])("rejects %j", async (amount) => {
    const { parseTransferAmount } = await walletCommands();
    await expect(parseTransferAmount(amount)).rejects.toThrow(
      /invalid amount|greater than 0/,
    );
  });

  it("rejects more than 18 decimals with its own message", async () => {
    const { parseTransferAmount } = await walletCommands();
    await expect(parseTransferAmount("1.0000000000000000001")).rejects.toThrow(
      "more than 18 decimals",
    );
  });

  // Issue #228: parsed before the network is known, so no coin is named.
  it.each([
    [
      "1.0000000000000000001",
      "the smallest unit (1 wei) is 0.000000000000000001.",
    ],
    ["x", "expected a positive decimal amount like 0.5."],
  ])("names no coin when rejecting %j", async (amount, text) => {
    const { parseTransferAmount } = await walletCommands();
    const error = await parseTransferAmount(amount).catch((e: Error) => e);
    expect(String(error)).toContain(text);
    expect(String(error)).not.toContain("ETH");
  });

  it.each([
    ["0.000000000000000001", 1n],
    ["1.5", 1500000000000000000n],
    ["00.5", 500000000000000000n],
    ["10", 10000000000000000000n],
  ])("accepts %j as %s wei", async (amount, wei) => {
    const { parseTransferAmount } = await walletCommands();
    await expect(parseTransferAmount(amount)).resolves.toBe(wei);
  });
});
