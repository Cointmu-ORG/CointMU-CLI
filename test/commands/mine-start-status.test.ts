import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  tmpDir,
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
});
