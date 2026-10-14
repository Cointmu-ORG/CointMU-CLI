import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  output,
  clearLogged,
  expectNoKeyLeak,
  setUp,
  tearDown,
} from "../helpers/walletEnv";
import { askingCommands } from "../helpers/walletSut";
import {
  TO,
  sendTransaction,
  send,
  mockChain,
  transfer,
  transferCli,
  transferSetUp,
} from "../helpers/walletTransfer";

beforeEach(setUp);
afterEach(tearDown);

describe("wallet transfer", () => {
  beforeEach(transferSetUp);

  // The hint after a missed confirmation depends on what eth_mining says.
  describe("unconfirmed hint", () => {
    const OLD_HINT =
      "blocks only appear while something mines - `cmu mine start`";
    const RECHECK = "check `cmu wallet balance` before sending again";

    async function timeOut(mining?: () => Promise<unknown>): Promise<string> {
      const { ethers } = await import("ethers");
      await mockChain({
        mining,
        wait: async () => {
          throw ethers.makeError("wait for transaction timeout", "TIMEOUT");
        },
      });
      await expect(transfer()).resolves.toBe(2);
      expectNoKeyLeak();
      const hint = output()
        .split("\n")
        .find((l) => l.includes("hint:"));
      expect(hint).toBeDefined();
      expect(hint).toContain(RECHECK);
      expect(hint).not.toContain(OLD_HINT);
      return hint as string;
    }

    it("on the local DevNet (no eth_mining) points at the node, not at mining", async () => {
      const hint = await timeOut(async () => {
        throw Object.assign(new Error("could not coalesce error"), {
          code: "UNKNOWN_ERROR",
          error: { code: -32004, message: "Method is not supported" },
        });
      });
      expect(hint).toContain(
        "the local DevNet puts each transaction in a block",
      );
      expect(hint).toContain("`cmu node start`");
      expect(hint).not.toContain("cmu mine");
    });

    it("on a geth node that is not mining offers mine start with its etherbase cost", async () => {
      const hint = await timeOut(async () => false);
      expect(hint).toContain("`cmu mine status`");
      expect(hint).toContain(
        "`cmu mine start` would move the node's etherbase to your wallet for everyone",
      );
    });

    it("on a geth node that is mining says to wait, not to start mining", async () => {
      const hint = await timeOut(async () => true);
      expect(hint).toContain("this node is mining");
      expect(hint).toContain("ethash builds its DAG");
      expect(hint).not.toContain("cmu mine start");
    });

    it("falls back when eth_mining fails", async () => {
      const hint = await timeOut(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8585");
      });
      expect(hint).toContain("the node did not answer a follow-up check");
    });

    it("gives up on eth_mining after the probe timeout", async () => {
      const { ethers } = await import("ethers");
      const { MINING_PROBE_TIMEOUT_MS } = await askingCommands();
      await mockChain({
        mining: () => new Promise(() => {}),
        wait: async () => {
          throw ethers.makeError("wait for transaction timeout", "TIMEOUT");
        },
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const result = transfer();
        await vi.waitFor(() =>
          expect(send).toHaveBeenCalledWith("eth_mining", []),
        );
        await vi.advanceTimersByTimeAsync(MINING_PROBE_TIMEOUT_MS);
        await expect(result).resolves.toBe(2);
      } finally {
        vi.useRealTimers();
      }
      expect(output()).toContain("the node did not answer a follow-up check");
      expect(output()).toContain(RECHECK);
    });
  });

  // The only proof of exit code 2: the devnet automines, so a smoke test
  // cannot make a confirmation time out.
  describe("exit codes through the commander action", () => {
    it("0 when sent and confirmed", async () => {
      await mockChain();
      const exit = await transferCli([TO, "1.5"]);
      expect(exit).toHaveBeenCalledWith(0);
      expect(exit).toHaveBeenCalledTimes(1);
    });

    it("2 when sent but not confirmed in time", async () => {
      const { ethers } = await import("ethers");
      await mockChain({
        wait: async () => {
          throw ethers.makeError("wait for transaction timeout", "TIMEOUT");
        },
      });
      const exit = await transferCli([TO, "1.5"]);
      expect(exit).toHaveBeenCalledWith(2);
      expect(exit).not.toHaveBeenCalledWith(0);
    });

    it("2 when sent, not confirmed, and eth_mining fails too", async () => {
      const { ethers } = await import("ethers");
      await mockChain({
        mining: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:8585");
        },
        wait: async () => {
          throw ethers.makeError("wait for transaction timeout", "TIMEOUT");
        },
      });
      const exit = await transferCli([TO, "1.5"]);
      expect(exit).toHaveBeenCalledWith(2);
      expect(exit).toHaveBeenCalledTimes(1);
    });

    it("2 when sent but the confirmation cannot be checked", async () => {
      await mockChain({
        wait: async () => {
          throw new Error("socket hang up");
        },
      });
      const exit = await transferCli([TO, "1.5"]);
      expect(exit).toHaveBeenCalledWith(2);
    });

    it("1 when the transaction reverts", async () => {
      const { ethers } = await import("ethers");
      await mockChain({
        wait: async () => {
          throw ethers.makeError(
            "transaction execution reverted",
            "CALL_EXCEPTION",
          );
        },
      });
      const exit = await transferCli([TO, "1.5"]);
      expect(exit).toHaveBeenCalledWith(1);
      expect(output()).toContain("was mined but reverted");
    });

    it("1 when refused, via the tf alias and -y", async () => {
      await mockChain({ refuse: true });
      const exit = await transferCli(["-y", TO, "1."], {});
      expect(exit).toHaveBeenCalledWith(1);
      expect(output()).toContain("wallet transfer failed");
      expect(sendTransaction).not.toHaveBeenCalled();

      clearLogged();
      vi.resetModules();
      const { walletCommand } = await askingCommands({});
      await walletCommand.parseAsync(["tf", "-y", TO, "1."], { from: "user" });
      expect(output()).toContain("invalid amount");
    });

    it("1 when sending throws, with the may-have-been-broadcast hint", async () => {
      await mockChain({ sendError: new Error("socket hang up") });
      const exit = await transferCli([TO, "1.5"]);
      expect(exit).toHaveBeenCalledWith(1);
      expect(output()).toContain("may still have been broadcast");
    });
  });
});
