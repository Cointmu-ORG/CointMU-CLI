import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PASSWORD,
  output,
  KEY_B,
  ADDRESS_A,
  ADDRESS_B,
  writeKeySession,
  expectNoKeyLeak,
  SESSION_HINT,
  hintOf,
  setUp,
  tearDown,
} from "../helpers/walletEnv";
import { asked, ctrlC } from "../helpers/walletSut";
import {
  TO,
  GWEI,
  AMOUNT_WEI,
  MAX_FEE_1559,
  sendTransaction,
  mockChain,
  transfer,
  sentRequest,
  transferSetUp,
} from "../helpers/walletTransfer";

beforeEach(setUp);
afterEach(tearDown);

describe("wallet transfer", () => {
  beforeEach(transferSetUp);

  describe("input routes", () => {
    it("TTY, confirmed: sends exactly what the summary showed", async () => {
      await mockChain();

      await expect(transfer()).resolves.toBe(0);

      expect(asked).toEqual(["password", "proceed"]);
      expect(sendTransaction).toHaveBeenCalledTimes(1);
      expect(sentRequest()).toEqual({
        to: TO,
        value: AMOUNT_WEI,
        gasLimit: 21_000n,
        type: 2,
        maxFeePerGas: 3n * GWEI,
        maxPriorityFeePerGas: 1n * GWEI,
      });
      expect(sendTransaction.mock.contexts[0]).toMatchObject({
        address: ADDRESS_A,
      });
      expect(output()).toContain("Network : local (chain ID 1912)");
      expect(output()).toContain(
        `From    : ${ADDRESS_A} (.cmu-session, saved as 'deployer')`,
      );
      expect(output()).toContain(`To      : ${TO}`);
      expect(output()).toContain(`Amount  : 1.5 ETH (${AMOUNT_WEI} wei)`);
      expect(output()).toContain("Max fee : 0.000063 ETH");
      expectNoKeyLeak();
    });

    // #194: a session left by 1.5.x `login` - a key saved nowhere else -
    // keeps signing with the session's password after the removal.
    it("TTY: signs from a session left by 1.5.x login", async () => {
      writeKeySession(ADDRESS_B, KEY_B);
      await mockChain();

      await expect(transfer({ to: ADDRESS_A })).resolves.toBe(0);

      expect(asked).toEqual(["password", "proceed"]);
      expect(sendTransaction.mock.contexts[0]).toMatchObject({
        address: ADDRESS_B,
      });
      expect(output()).toContain(`From    : ${ADDRESS_B} (.cmu-session)`);
      expectNoKeyLeak();
    });

    it("TTY, declined: aborts and sends nothing", async () => {
      await mockChain({ refuse: true });

      await expect(
        transfer({}, { password: PASSWORD, proceed: false }),
      ).rejects.toThrow("aborted: nothing was sent");

      expect(asked).toEqual(["password", "proceed"]);
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it("TTY, Ctrl-C at the confirmation: sends nothing", async () => {
      await mockChain({ refuse: true });

      await expect(
        transfer({}, { password: PASSWORD, proceed: ctrlC() }),
      ).rejects.toThrow("aborted: nothing was sent");
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it("TTY, Ctrl-C at the password: sends nothing", async () => {
      await mockChain({ refuse: true });

      await expect(transfer({}, { password: ctrlC() })).rejects.toThrow(
        "aborted: nothing was sent",
      );
      expect(asked).toEqual(["password"]);
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it("TTY, wrong password: hints at the session, sends nothing", async () => {
      await mockChain({ refuse: true });

      const error = await transfer(
        {},
        { password: "wrong password 1", proceed: true },
      ).catch((e: Error) => e);

      expect(hintOf(error)).toBe(SESSION_HINT);
      expect((error as Error).message).not.toContain("wallet login");
      expect(asked).toEqual(["password"]);
      expect(sendTransaction).not.toHaveBeenCalled();
      expectNoKeyLeak();
    });

    it("TTY with --yes: asks for the password only, then sends", async () => {
      await mockChain();

      await expect(
        transfer({ yes: true }, { password: PASSWORD }),
      ).resolves.toBe(0);
      expect(asked).toEqual(["password"]);
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["with --yes", true],
      ["without --yes", false],
    ])(
      "non-TTY %s: refuses at the password, prompts nothing, sends nothing",
      async (_, yes) => {
        await mockChain({ refuse: true });
        process.stdin.isTTY = false;

        const error = await transfer({ yes }).catch((e: Error) => e);

        expect((error as Error).message).toContain("non-interactive session");
        expect(hintOf(error)).toBe(
          "hint: transfer signs with the .cmu-session key and needs its password; run it in a terminal.",
        );
        expect(asked).toEqual([]);
        expect(sendTransaction).not.toHaveBeenCalled();
      },
    );
  });

  // --yes skips the one confirmation question and nothing else.
  describe("--yes does not bypass validation", () => {
    async function expectRefused(
      args: { to?: string; amount?: string },
      message: string | RegExp,
    ) {
      await mockChain({ refuse: true });
      await expect(transfer({ ...args, yes: true })).rejects.toThrow(message);
      expect(asked).toEqual([]);
      expect(sendTransaction).not.toHaveBeenCalled();
    }

    it.each([
      "0x123",
      ADDRESS_B.slice(2),
      `0X${ADDRESS_B.slice(2)}`,
      "XE7338O073KYGTWWZN0F2WZ0R8PX5ZPPZS",
      "vitalik.eth",
      ` ${ADDRESS_B}`,
    ])("invalid recipient %j", (to) =>
      expectRefused({ to }, "invalid recipient"),
    );

    it("recipient with a wrong checksum", () =>
      expectRefused(
        { to: ADDRESS_B.replace("C44", "c44") },
        "bad address checksum",
      ));

    it.each([
      "0",
      "0.0",
      "-1",
      "+1",
      "1e3",
      "0x10",
      "1_000",
      " 1",
      "1,5",
      "",
      ".",
      "1.",
      ".5",
      "Infinity",
      "１",
      "1x5",
      "1.5\n",
    ])("invalid amount %j", (amount) =>
      expectRefused({ amount }, /invalid amount|greater than 0/),
    );

    it("amount with 19 decimals", () =>
      expectRefused(
        { amount: "1.0000000000000000001" },
        "more than 18 decimals",
      ));

    it("balance below the amount", async () => {
      await mockChain({ refuse: true, balance: AMOUNT_WEI - 1n });
      await expect(transfer({ yes: true })).rejects.toThrow(
        "insufficient balance",
      );
      expect(asked).toEqual([]);
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it("balance that covers the amount but not the max fee", async () => {
      await mockChain({
        refuse: true,
        balance: AMOUNT_WEI + MAX_FEE_1559 - 1n,
      });
      await expect(transfer({ yes: true })).rejects.toThrow(
        "covers the amount but not the max fee",
      );
      expect(asked).toEqual([]);
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it("the zero address", async () => {
      await mockChain({ refuse: true });
      await expect(
        transfer({
          to: "0x0000000000000000000000000000000000000000",
          yes: true,
        }),
      ).rejects.toThrow("--yes does not cover sending to the zero address");
      expect(asked).toEqual([]);
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });
});
