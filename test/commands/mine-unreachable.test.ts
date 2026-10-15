import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  connectionError,
  node,
  sent,
  output,
  mineSetUp,
  mineTearDown,
  runFailing,
} from "../helpers/mineEnv";

// Issue #214: `mine` talked to the node with a bare provider, so a node that
// was down printed ethers' retry notice and a raw ECONNREFUSED.

describe("mine on a node that is down", () => {
  beforeEach(mineSetUp);
  afterEach(mineTearDown);

  it.each([["status"], ["start"], ["stop"]])(
    "mine %s reports it the way other commands do",
    async (sub) => {
      node.down = connectionError;

      const errors = await runFailing(sub);

      expect(errors).toContain(`mine ${sub} failed`);
      expect(errors).toContain(
        "RPC endpoint http://127.0.0.1:8585 is unreachable",
      );
      expect(errors).toContain("cmu network list");
      expect(errors).not.toContain("ECONNREFUSED");
      // Nothing reached the node, and nothing claims it did.
      expect(sent).toEqual([]);
      expect(output()).not.toMatch(/Setting etherbase|Stopping miner/);
    },
  );
});
