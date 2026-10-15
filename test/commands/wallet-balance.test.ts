import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  output,
  setUp,
  tearDown,
  tmpDir,
  writeSession,
} from "../helpers/walletEnv";

// Issue #228: `wallet balance` labels the amount with the active network's
// symbol, and keeps ETH for networks saved before symbols existed.

const RPC_URL = "http://127.0.0.1:9999";

beforeEach(setUp);
afterEach(tearDown);

describe("wallet balance", () => {
  async function balance(networks: object[] | null): Promise<string> {
    if (networks) {
      fs.writeFileSync(
        path.join(tmpDir, ".cmu-networks.json"),
        JSON.stringify(networks),
      );
    }
    writeSession("local");
    const { ethers } = await import("ethers");
    vi.spyOn(ethers.JsonRpcProvider.prototype, "getNetwork").mockResolvedValue(
      ethers.Network.from(1912),
    );
    vi.spyOn(ethers.JsonRpcProvider.prototype, "getBalance").mockResolvedValue(
      15n * 10n ** 17n,
    );
    const { runWalletBalance } = await import("../../src/commands/wallet/info");
    await runWalletBalance();
    return output();
  }

  it("keeps ETH for a networks file saved before symbols", async () => {
    expect(await balance([{ name: "local", rpcUrl: RPC_URL }])).toContain(
      "Balance : 1.5 ETH",
    );
  });

  it("uses the symbol saved with the network", async () => {
    expect(
      await balance([{ name: "local", rpcUrl: RPC_URL, symbol: "CMU" }]),
    ).toContain("Balance : 1.5 CMU");
  });

  it("uses CMU on a freshly seeded local network", async () => {
    expect(await balance(null)).toContain("Balance : 1.5 CMU");
  });

  it("refuses a hand-edited symbol before connecting", async () => {
    const { ethers } = await import("ethers");
    const getBalance = vi.spyOn(ethers.JsonRpcProvider.prototype, "getBalance");
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-networks.json"),
      JSON.stringify([{ name: "local", rpcUrl: RPC_URL, symbol: "c m" }]),
    );
    writeSession("local");
    const { runWalletBalance } = await import("../../src/commands/wallet/info");

    await expect(runWalletBalance()).rejects.toThrow(
      "network 'local' has an invalid symbol",
    );
    expect(getBalance).not.toHaveBeenCalled();
  });

  // Issue #214: a bare provider printed ethers' retry notice and a raw error.
  it("reports a node that is down the way other commands do", async () => {
    const { ethers } = await import("ethers");
    vi.spyOn(ethers.JsonRpcProvider.prototype, "getNetwork").mockRejectedValue(
      new Error("connect ECONNREFUSED 127.0.0.1:9999"),
    );
    const getBalance = vi
      .spyOn(ethers.JsonRpcProvider.prototype, "getBalance")
      .mockResolvedValue(0n);
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-networks.json"),
      JSON.stringify([{ name: "local", rpcUrl: RPC_URL }]),
    );
    writeSession("local");
    const { runWalletBalance } = await import("../../src/commands/wallet/info");

    await expect(runWalletBalance()).rejects.toThrow(
      `RPC endpoint ${RPC_URL} is unreachable`,
    );
    expect(getBalance).not.toHaveBeenCalled();
  });
});
