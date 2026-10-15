import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  ADDRESS,
  OTHER,
  ETH,
  unsupported,
  connectionError,
  etherbaseUnset,
  otherServerError,
  node,
  sent,
  tmpDir,
  output,
  mineSetUp,
  mineTearDown,
  run,
  runFailing,
  runSucceeding,
  minerCalls,
  writeNetworksFile,
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

    // Issue #210: a fresh geth node has no etherbase, and setting one is what
    // start is for.
    it("start sets the etherbase on a node that has none yet", async () => {
      node.rpc.eth_coinbase = etherbaseUnset;

      await runSucceeding("start");

      expect(minerCalls()).toEqual([
        ["miner_setEtherbase", [ADDRESS]],
        ["miner_start", [1]],
      ]);
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

    // Issue #228: only the watch prints an amount, so only it reads the symbol,
    // and it does so before any miner call.
    describe("with a hand-edited symbol", () => {
      beforeEach(() => {
        writeNetworksFile([
          { name: "local", rpcUrl: "http://127.0.0.1:8585", symbol: "C M" },
        ]);
      });

      it("start --watch refuses before touching the miner", async () => {
        const errors = await runFailing("start", "--watch");

        expect(errors).toContain("network 'local' has an invalid symbol");
        expect(minerCalls()).toEqual([]);
      });

      it("stop still stops the miner", async () => {
        await run("stop");

        expect(sent).toEqual([["miner_stop", []]]);
      });
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
      // The fake chain is dated 2023, so its age is in days (#211).
      expect(out).toMatch(/Latest block : #10, \d+d ago/);
      expect(out).toContain("Difficulty   : 131072");
      expect(out).toContain(`Wallet       : ${ADDRESS}`);
      expect(out).toContain("Balance      : 2.0 ETH");
      // Read-only: nothing that changes the node.
      expect(minerCalls()).toEqual([]);
    });

    // Issue #228. The ETH case is the test above: mineSetUp() writes a
    // networks file from before symbols.
    it("labels the balance with the symbol saved with the network", async () => {
      writeNetworksFile([
        { name: "local", rpcUrl: "http://127.0.0.1:8585", symbol: "CMU" },
      ]);

      await run("status");

      expect(output()).toContain("Balance      : 2.0 CMU");
    });

    it("refuses a hand-edited symbol before reading the node", async () => {
      writeNetworksFile([
        { name: "local", rpcUrl: "http://127.0.0.1:8585", symbol: "C M" },
      ]);

      const errors = await runFailing("status");

      expect(errors).toContain("network 'local' has an invalid symbol");
      expect(sent).toEqual([]);
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

    // Issue #211: EDR answers eth_coinbase with a placeholder but has no miner
    // API and no block rewards, so its etherbase means nothing either.
    it.each(Object.entries(unsupported))(
      "shows n/a for the etherbase of a node without eth_mining (%s error shape)",
      async (_shape, makeError) => {
        node.rpc.eth_mining = makeError;
        node.rpc.eth_hashrate = makeError;
        node.rpc.eth_coinbase = "0xc014ba5ec014ba5ec014ba5ec014ba5ec014ba5e";

        await run("status");

        const out = output();
        expect(out).toContain("Etherbase    : n/a\n");
        expect(out).not.toContain("0xc014ba5e");
        expect(out).not.toContain("rewards go there");
      },
    );

    // Issue #210: "none set" is a state of the node, not a missing method.
    it("shows none set on a node with no etherbase yet", async () => {
      node.rpc.eth_coinbase = etherbaseUnset;

      await runSucceeding("status");

      const out = output();
      expect(out).toContain("Etherbase    : none set\n");
      expect(out).not.toContain("not your session wallet");
      expect(out).toContain("Balance      : 2.0 ETH");
    });

    it("still fails on another -32000 answer to eth_coinbase", async () => {
      node.rpc.eth_coinbase = otherServerError;

      const errors = await runFailing("status");

      expect(errors).toContain("mine status failed");
      expect(errors).toContain("internal error");
      expect(output()).not.toContain("none set");
    });

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
