import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADDRESS,
  OTHER,
  ETH,
  unsupported,
  connectionError,
  node,
  extend,
  FakeProvider,
  log,
  output,
  mineSetUp,
  mineTearDown,
  run,
  minerCalls,
} from "../helpers/mineEnv";

describe("mineCommand", () => {
  beforeEach(mineSetUp);
  afterEach(mineTearDown);

  describe("watchMining", () => {
    /**
     * Drives the watch one poll per script entry: entry i runs after poll i,
     * before poll i + 1. The watch is aborted after the last poll.
     */
    async function watch(...script: Array<() => void>) {
      const { watchMining } = await import("../../src/commands/mine");
      const controller = new AbortController();
      const delays: number[] = [];
      let i = 0;
      await watchMining(
        new FakeProvider() as any,
        ADDRESS,
        controller.signal,
        async (ms) => {
          delays.push(ms);
          if (i < script.length) script[i++]();
          else controller.abort();
        },
      );
      return {
        delays,
        lines: log.mock.calls.map((c: unknown[]) => String(c[0])),
      };
    }

    const count = (lines: string[], text: string) =>
      lines.filter((l) => l.includes(text)).length;

    it("counts every block mined by the wallet, even several between two polls", async () => {
      const { lines } = await watch(() => extend(3, ADDRESS));

      expect(count(lines, "mined by you.")).toBe(3);
      expect(lines).toContain("block #11 mined by you.");
      expect(lines).toContain("block #13 mined by you.");
      expect(lines.at(-1)).toContain("mined by you since #10: 3");
    });

    it("recounts after a reorg replaces the wallet's block", async () => {
      const { lines } = await watch(
        () => extend(2, ADDRESS), // #11, #12 ours
        () => {
          node.chain.length = 11; // drop #11, #12
          extend(2, OTHER, "b"); // replaced by someone else's
        },
      );

      expect(count(lines, "reorg: blocks from #11 were replaced")).toBe(1);
      expect(lines.at(-1)).toContain("#12 ");
      expect(lines.at(-1)).toContain("mined by you since #10: 0");
    });

    it("reports the balance change since the start", async () => {
      node.balance = (n) => (n >= 11 ? 3n * ETH : 1n * ETH);

      const { lines } = await watch(() => extend(1, ADDRESS));

      expect(lines.at(-1)).toContain("balance 3.0 ETH (change +2.0)");
    });

    it("degrades to n/a on a node without eth_hashrate and reports no etherbase change", async () => {
      node.rpc.eth_hashrate = unsupported.edr;
      node.rpc.eth_coinbase = unsupported.edr;
      node.rpc.eth_mining = unsupported.edr;

      const { lines } = await watch(() => extend(1, OTHER));

      expect(lines.at(-1)).toContain("hashrate n/a");
      expect(count(lines, "etherbase")).toBe(0);
      expect(count(lines, "mining stopped")).toBe(0);
    });

    it("reports an etherbase takeover exactly once, however many polls see it", async () => {
      const { lines } = await watch(
        () => (node.rpc.eth_coinbase = OTHER),
        () => extend(1, OTHER),
        () => extend(1, OTHER),
      );

      expect(count(lines, `rewards now go to ${OTHER}`)).toBe(1);
    });

    it("reports the etherbase coming back to the session wallet", async () => {
      const { lines } = await watch(
        () => (node.rpc.eth_coinbase = OTHER),
        () => (node.rpc.eth_coinbase = ADDRESS),
        () => {},
      );

      expect(count(lines, `rewards now go to ${OTHER}`)).toBe(1);
      expect(count(lines, "etherbase is back on your wallet")).toBe(1);
    });

    it("reports mining stopping once", async () => {
      node.rpc.eth_mining = true;

      const { lines } = await watch(
        () => (node.rpc.eth_mining = false),
        () => {},
      );

      expect(count(lines, "mining stopped")).toBe(1);
    });

    it("survives a dropped connection, backs off, and says when it is back", async () => {
      const { delays, lines } = await watch(
        () => (node.down = connectionError),
        () => {},
        () => (node.down = undefined),
      );

      expect(delays).toEqual([4000, 4000, 8000, 4000]);
      expect(lines).toContain(
        "connection lost (connect ECONNREFUSED 127.0.0.1:8585), retrying in 4s",
      );
      expect(lines).toContain(
        "connection lost (connect ECONNREFUSED 127.0.0.1:8585), retrying in 8s",
      );
      expect(count(lines, "reconnected.")).toBe(1);
    });

    it("caps the backoff at 60 s", async () => {
      const { backoff } = await import("../../src/commands/mine");

      expect([1, 2, 3, 4, 5, 10].map(backoff)).toEqual([
        4000, 8000, 16000, 32000, 60000, 60000,
      ]);
    });

    it("resolves cleanly when aborted mid-sleep (the real AbortError path)", async () => {
      const { watchMining } = await import("../../src/commands/mine");
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);

      await expect(
        watchMining(new FakeProvider() as any, ADDRESS, controller.signal),
      ).resolves.toBeUndefined();
    });

    it("resolves when aborted while a poll hangs on a dead node", async () => {
      const { watchMining } = await import("../../src/commands/mine");
      node.hang = true;
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);

      await expect(
        watchMining(new FakeProvider() as any, ADDRESS, controller.signal),
      ).resolves.toBeUndefined();
    });

    it("prints one line per event and never redraws when stdout is not a terminal", async () => {
      const write = vi.spyOn(process.stdout, "write");

      const { lines } = await watch(() => {
        extend(1, ADDRESS);
        node.rpc.eth_coinbase = OTHER;
      });

      // The `warning:` colour stays, as everywhere else in the CLI; only the
      // redraw codes are terminal-only.
      expect(count(lines, `rewards now go to ${OTHER}`)).toBe(1);
      expect(lines.join("\n")).not.toContain("\r");
      expect(lines.join("\n")).not.toContain("\x1b[2K");
      expect(write).not.toHaveBeenCalled();
    });
  });

  it("start --watch leaves on Ctrl-C with exit 0, says mining keeps running, and never goes through fail()", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as any);
    let onSigint: (() => void) | undefined;
    vi.spyOn(process, "once").mockImplementation(((
      event: string,
      handler: () => void,
    ) => {
      if (event === "SIGINT") onSigint = handler;
      return process;
    }) as any);

    const running = run("start", "--watch");
    await vi.waitFor(() =>
      expect(output()).toContain("mined by you since #10"),
    );
    onSigint!();
    await running;

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(error).not.toHaveBeenCalled();
    expect(output()).toContain(
      "Stopped watching. Mining is still running on local - stop it with `cmu mine stop`.",
    );
    expect(minerCalls().map(([m]) => m)).not.toContain("miner_stop");
  });
});
