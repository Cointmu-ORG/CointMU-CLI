import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PASSWORD,
  output,
  ADDRESS_A,
  ADDRESS_B,
  expectNoKeyLeak,
  setUp,
  tearDown,
} from "../helpers/walletEnv";
import { asked, askingCommands } from "../helpers/walletSut";
import {
  TO,
  TX_HASH,
  GWEI,
  AMOUNT_WEI,
  MAX_FEE_1559,
  sendTransaction,
  wait,
  mockChain,
  transfer,
  sentRequest,
  transferSetUp,
} from "../helpers/walletTransfer";

beforeEach(setUp);
afterEach(tearDown);

describe("wallet transfer", () => {
  beforeEach(transferSetUp);

  describe("recipients", () => {
    it.each([
      ["all lowercase", ADDRESS_B.toLowerCase()],
      ["all uppercase", `0x${ADDRESS_B.slice(2).toUpperCase()}`],
    ])("accepts %s and sends to the checksummed form", async (_, to) => {
      await mockChain();
      await transfer({ to });
      expect(sentRequest().to).toBe(ADDRESS_B);
    });

    it("warns that the zero address burns, then asks", async () => {
      await mockChain();
      await transfer({ to: "0x0000000000000000000000000000000000000000" });
      expect(output()).toContain("burned and cannot be recovered");
      expect(asked).toEqual(["password", "proceed"]);
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    });

    it("warns when sending to itself", async () => {
      await mockChain();
      await transfer({ to: ADDRESS_A, yes: true }, { password: PASSWORD });
      expect(output()).toContain("is the sending wallet");
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    });

    it("warns when the recipient is a contract", async () => {
      await mockChain({ code: "0x6080604052" });
      await transfer({ yes: true }, { password: PASSWORD });
      expect(output()).toContain("is a contract");
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    });

    it("refuses a contract that rejects the transfer, before any prompt", async () => {
      await mockChain({
        refuse: true,
        code: "0x6080604052",
        estimateError: new Error("execution reverted"),
      });
      await expect(transfer()).rejects.toThrow("would reject this transfer");
      expect(asked).toEqual([]);
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  describe("amount and balance", () => {
    it("sends the smallest amount, 1 wei", async () => {
      await mockChain();
      await transfer({ amount: "0.000000000000000001" });
      expect(sentRequest().value).toBe(1n);
    });

    it("accepts a balance of exactly amount + max fee", async () => {
      await mockChain({ balance: AMOUNT_WEI + MAX_FEE_1559 });
      await expect(transfer()).resolves.toBe(0);
    });
  });

  describe("fees", () => {
    it("legacy fee data: sends type 0 with gasPrice", async () => {
      await mockChain({ feeData: [2n * GWEI, null, null] });
      await transfer();
      expect(sentRequest()).toEqual({
        to: TO,
        value: AMOUNT_WEI,
        gasLimit: 21_000n,
        type: 0,
        gasPrice: 2n * GWEI,
      });
      expect(output()).toContain("Max fee : 0.000042 ETH");
    });

    it("refuses when the node returns no fee data", async () => {
      await mockChain({ refuse: true, feeData: [null, null, null] });
      await expect(transfer()).rejects.toThrow("no fee data");
      expect(asked).toEqual([]);
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  describe("after sending", () => {
    it("prints the block and the new balance in the balance format", async () => {
      await mockChain();
      await transfer();
      expect(output()).toContain(`Tx hash : ${TX_HASH}`);
      expect(output()).toContain("Block   : 42");
      expect(output()).toMatch(/Balance : 10\.0 ETH/);
    });

    it("waits for 1 confirmation with the named timeout", async () => {
      await mockChain();
      const { TRANSFER_CONFIRM_TIMEOUT_MS } = await askingCommands();
      await transfer();
      expect(wait).toHaveBeenCalledWith(1, TRANSFER_CONFIRM_TIMEOUT_MS);
    });

    it("prints the hash before waiting, and reports a timeout", async () => {
      const { ethers } = await import("ethers");
      let printedBeforeWait = "";
      await mockChain({
        wait: async () => {
          printedBeforeWait = output();
          throw ethers.makeError("wait for transaction timeout", "TIMEOUT");
        },
      });

      await expect(transfer()).resolves.toBe(2);

      expect(printedBeforeWait).toContain(TX_HASH);
      expect(output()).toContain("was sent but is not in a block after 120s");
      expectNoKeyLeak();
    });
  });
});
