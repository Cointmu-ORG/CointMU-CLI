import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  ADDRESS,
  OTHER,
  ETH,
  unsupported,
  connectionError,
  node,
  sent,
  extend,
  FakeProvider,
  tmpDir,
  log,
  output,
  mineSetUp,
  mineTearDown,
  run,
  runFailing,
  minerCalls,
} from "../helpers/mineEnv";

// `mine start` and `mine stop` share one code path. Only start may touch the
// etherbase, since that decides which wallet the rewards go to.

describe("mineCommand", () => {
  beforeEach(mineSetUp);
  afterEach(mineTearDown);

  describe("start / stop", () => {
    it("start points the etherbase at the session wallet, then starts one thread", async () => {
      await run("start");

      expect(minerCalls()).toEqual([
        ["miner_setEtherbase", [ADDRESS]],
        ["miner_start", [1]],
      ]);
    });

    it("stop only stops the miner", async () => {
      await run("stop");

      expect(sent).toEqual([["miner_stop", []]]);
    });

    it("warns when the node already mines to someone else, then still takes over", async () => {
      node.rpc.eth_mining = true;
      node.rpc.eth_coinbase = OTHER;

      await run("start");

      expect(output()).toContain(
        `warning:\x1b[0m this node is already mining to ${OTHER}`,
      );
      expect(minerCalls()).toEqual([
        ["miner_setEtherbase", [ADDRESS]],
        ["miner_start", [1]],
      ]);
    });

    it.each([
      ["not mining, foreign etherbase", false, OTHER],
      [
        "mining to the session wallet in another case",
        true,
        ADDRESS.toLowerCase(),
      ],
    ])("does not warn when %s", async (_label, mining, coinbase) => {
      node.rpc.eth_mining = mining;
      node.rpc.eth_coinbase = coinbase;

      await run("start");

      expect(output()).not.toContain("warning:");
    });

    it("explains a node without miner_setEtherbase instead of dumping the ethers error", async () => {
      // The local DevNet's answer to every miner_* call.
      node.rpc.eth_mining = unsupported.edr;
      node.rpc.miner_setEtherbase = unsupported.edr;

      const errors = await runFailing("start");

      expect(errors).toContain("network 'local' has no miner_setEtherbase RPC");
      expect(errors).toContain(
        "the local DevNet mines a block for each transaction",
      );
      expect(errors).not.toContain("could not coalesce");
      expect(minerCalls()).toEqual([["miner_setEtherbase", [ADDRESS]]]);
    });

    it("explains a node without miner_stop", async () => {
      node.rpc.miner_stop = unsupported.edr;

      expect(await runFailing("stop")).toContain(
        "network 'local' has no miner_stop RPC",
      );
    });

    it("passes other miner errors through unchanged", async () => {
      node.rpc.miner_start = connectionError;

      const errors = await runFailing("start");

      expect(errors).toContain("ECONNREFUSED");
      expect(errors).not.toContain("no miner_start RPC");
    });
  });

  describe("status", () => {
    beforeEach(() => {
      node.rpc.eth_mining = true;
      node.rpc.eth_hashrate = "0x124f80"; // 1,200,000 H/s
      node.balance = () => 2n * ETH;
    });

    it("shows mining, hashrate, etherbase, latest block, difficulty and balance", async () => {
      await run("status");

      const out = output();
      expect(out).toContain("Network      : local (http://127.0.0.1:8585)");
      expect(out).toContain("Mining       : yes");
      expect(out).toContain("Hashrate     : 1.20 MH/s");
      expect(out).toContain(`Etherbase    : ${ADDRESS.toLowerCase()}\n`);
      expect(out).toMatch(/Latest block : #10, \d+[smh] ago/);
      expect(out).toContain("Difficulty   : 131072");
      expect(out).toContain(`Wallet       : ${ADDRESS}`);
      expect(out).toContain("Balance      : 2.0 ETH");
      // Read-only: nothing that changes the node.
      expect(minerCalls()).toEqual([]);
    });

    it("flags an etherbase that is not the session wallet", async () => {
      node.rpc.eth_coinbase = OTHER;

      await run("status");

      expect(output()).toContain(
        `Etherbase    : ${OTHER} (not your session wallet - rewards go there)`,
      );
    });

    it.each(Object.entries(unsupported))(
      "shows n/a for a method the node lacks (%s error shape)",
      async (_shape, makeError) => {
        node.rpc.eth_mining = makeError;
        node.rpc.eth_hashrate = makeError;
        node.rpc.eth_coinbase = makeError;

        await run("status");

        const out = output();
        expect(out).toContain("Mining       : n/a");
        expect(out).toContain("Hashrate     : n/a");
        expect(out).toContain("Etherbase    : n/a\n");
        expect(out).toContain("Balance      : 2.0 ETH");
      },
    );

    it("fails on a network error instead of showing n/a", async () => {
      node.rpc.eth_hashrate = connectionError;

      const errors = await runFailing("status");

      expect(errors).toContain("mine status failed");
      expect(errors).toContain("ECONNREFUSED");
      expect(output()).not.toContain("n/a");
    });

    it("needs a session, and says how to get one", async () => {
      fs.rmSync(path.join(tmpDir, ".cmu-session"));

      const errors = await runFailing("status");

      expect(errors).toContain("no active session");
      expect(errors).toContain("hint:");
    });
  });

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
