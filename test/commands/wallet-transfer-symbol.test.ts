import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  PASSWORD,
  output,
  setUp,
  tearDown,
  tmpDir,
} from "../helpers/walletEnv";
import { asked } from "../helpers/walletSut";
import {
  AMOUNT_WEI,
  ETH,
  mockChain,
  sendTransaction,
  transfer,
  transferSetUp,
} from "../helpers/walletTransfer";

// Issue #228: every amount `wallet transfer` prints carries the active
// network's symbol. The ETH cases are the rest of the transfer suite, whose
// networks file predates symbols.

beforeEach(setUp);
afterEach(tearDown);

describe("wallet transfer on a network saved with a symbol", () => {
  beforeEach(async () => {
    await transferSetUp();
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-networks.json"),
      JSON.stringify([
        { name: "local", rpcUrl: "http://127.0.0.1:9999", symbol: "CMU" },
      ]),
    );
  });

  it("labels the summary and the new balance with it", async () => {
    await mockChain();
    await transfer();

    expect(output()).toContain(`Amount  : 1.5 CMU (${AMOUNT_WEI} wei)`);
    expect(output()).toContain("Max fee : 0.000063 CMU");
    expect(output()).toContain("Balance : 10.0 CMU");
    expect(output()).not.toContain("ETH");
  });

  it("labels a balance below the amount with it", async () => {
    await mockChain({ refuse: true, balance: 1n * ETH });

    await expect(transfer()).rejects.toThrow(
      "insufficient balance: 1.0 CMU, the transfer needs 1.5 CMU plus fee.",
    );
    expect(asked).toEqual([]);
  });

  it("labels a balance that cannot cover the max fee with it", async () => {
    await mockChain({ refuse: true, balance: AMOUNT_WEI });

    await expect(transfer()).rejects.toThrow(
      "balance 1.5 CMU covers the amount but not the max fee (0.000063 CMU).",
    );
  });

  it("names it in the contract warning", async () => {
    await mockChain({ code: "0x6080604052" });
    await transfer({ yes: true }, { password: PASSWORD });

    expect(output()).toContain("plain CMU can be rejected or locked by it");
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("names it in the hint for a contract that rejects the transfer", async () => {
    await mockChain({
      refuse: true,
      code: "0x6080604052",
      estimateError: new Error("execution reverted"),
    });

    await expect(transfer()).rejects.toThrow("cannot take plain CMU");
  });

  it("refuses a hand-edited symbol before any RPC or prompt", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-networks.json"),
      JSON.stringify([
        { name: "local", rpcUrl: "http://127.0.0.1:9999", symbol: "c-m" },
      ]),
    );
    await mockChain({ refuse: true, networkError: new Error("must not ping") });

    await expect(transfer()).rejects.toThrow(
      "network 'local' has an invalid symbol",
    );
    expect(asked).toEqual([]);
  });
});
