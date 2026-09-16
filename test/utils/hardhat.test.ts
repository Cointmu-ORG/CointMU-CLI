import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_BALANCE,
  ACCOUNT_COUNT,
  devnetOverride,
  silenceHardhatNoise,
} from "../../src/utils/hardhat";
import { LOCAL_CHAIN_ID } from "../../src/utils/defaults";

// `cmu test` and `cmu node start` both drive Hardhat in-process and both used
// to carry their own copy of this filter. These cover the shared one.

describe("silenceHardhatNoise", () => {
  const handles: { restore(): void }[] = [];

  function silence(...args: Parameters<typeof silenceHardhatNoise>) {
    const handle = silenceHardhatNoise(...args);
    handles.push(handle);
    return handle;
  }

  afterEach(() => {
    // Restore in reverse order, innermost patch first.
    handles
      .splice(0)
      .reverse()
      .forEach((handle) => handle.restore());
    vi.restoreAllMocks();
  });

  it("swallows the dependency noise on error, warn and log alike", () => {
    const spies = {
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
    };
    silence();

    console.error("Cannot find module 'uws_win32'");
    console.warn("Falling back to a NodeJS implementation");
    console.log("Require stack:\n- /app/node_modules/uws-js-unofficial/x.js");

    expect(spies.error).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.log).not.toHaveBeenCalled();
  });

  it("prints a module-resolution failure that has nothing to do with uWS", () => {
    // The filter used to match a bare "Cannot find module" / "Require stack:",
    // so a project missing a real dependency reported nothing at all.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    silence();

    console.error("Error: Cannot find module 'ethers'");
    console.error("Require stack:\n- /app/deploy/01_token.js");

    expect(error).toHaveBeenCalledTimes(2);
  });

  it("lets anything that is not noise through untouched", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    silence();

    console.log("Compiling contracts...", 42);

    expect(log).toHaveBeenCalledWith("Compiling contracts...", 42);
  });

  it("prints everything when verbose is set", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    silence({ verbose: true });

    console.error("Cannot find module 'uws_win32'");

    expect(error).toHaveBeenCalledOnce();
  });

  it("swallows caller-supplied patterns too", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    silence({ extraPatterns: ["You are not inside a Hardhat project"] });

    console.log("Warning: You are not inside a Hardhat project");
    console.log("kept");

    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("kept");
  });

  it("lets onLog take over a line so it is not printed twice", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const seen: string[] = [];
    silence({
      onLog: (msg, _args, originalLog) => {
        if (!msg.startsWith("eth_")) return false;
        seen.push(msg);
        originalLog(`rpc: ${msg}`);
        return true;
      },
    });

    console.log("eth_blockNumber");
    console.log("something else");

    expect(seen).toEqual(["eth_blockNumber"]);
    expect(log).toHaveBeenCalledWith("rpc: eth_blockNumber");
    expect(log).toHaveBeenCalledWith("something else");
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("never consults onLog for a line the noise filter already dropped", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const onLog = vi.fn(() => false);
    silence({ onLog });

    console.log("Cannot find module 'uws_win32'");

    expect(onLog).not.toHaveBeenCalled();
  });

  it("hands back the unpatched functions, and restore() puts them back", () => {
    const before = console.log;
    const handle = silenceHardhatNoise();

    expect(handle.log).toBe(before);
    expect(console.log).not.toBe(before);

    handle.restore();
    expect(console.log).toBe(before);
  });
});

// Issue #117: the devnet settings used to be written onto
// `hre.config.networks.hardhat`, a network Hardhat 3 does not have, on the
// already-resolved config. Nothing read it, so every command ran against
// Hardhat's stock chain ID and its publicly known test accounts while printing
// - and handing out - keys derived from a mnemonic that funded nothing. This
// boots the real runtime because that is the only place the gap was visible.
//
// It goes through devnetOverride() rather than bootHardhat(): the latter loads
// Hardhat through a `new Function` indirection that vitest's module runner
// cannot execute ("A dynamic import callback was not specified"). Every CLI run
// exercises that half; this covers the half that decides what the chain serves.

describe("devnetOverride", () => {
  // A valid BIP-39 phrase that is deliberately NOT Hardhat's default: with the
  // default one the assertions below would pass even if the override were
  // dropped again.
  const MNEMONIC =
    "legal winner thank year wave sausage worth useful legal winner thank yellow";

  // @nomicfoundation/edr@0.19.0 declares `engines: { node: ">= 22" }`, so on
  // Node 20 npm skips its native binary and no EDR chain can start at all -
  // which is equally why `cmu test` and `cmu node start` cannot work there,
  // independently of this test. There is nothing to assert when the chain
  // cannot boot, so this only runs where it can.
  const canBootEdr = Number(process.versions.node.split(".")[0]) >= 22;

  it.skipIf(!canBootEdr)(
    "makes Hardhat serve the accounts derived from its mnemonic",
    async () => {
      // Mirrors src/index.ts, which is not on the path in a unit test.
      process.env.HARDHAT_CONFIG = fileURLToPath(
        new URL("../../hardhat.config.js", import.meta.url),
      );

      const { mnemonic, override } = await devnetOverride({
        mnemonic: MNEMONIC,
        loggingEnabled: false,
      });
      expect(mnemonic).toBe(MNEMONIC);

      const hre: any = (await import("hardhat")).default;
      const connection = await hre.network.create({ override });
      try {
        const { ethers } = await import("ethers");
        const derived = (index: number) =>
          ethers.HDNodeWallet.fromMnemonic(
            ethers.Mnemonic.fromPhrase(mnemonic),
            `m/44'/60'/0'/0/${index}`,
          ).address.toLowerCase();

        const accounts: string[] = await connection.provider.request({
          method: "eth_accounts",
          params: [],
        });

        // The whole point: what the CLI prints is what the chain serves.
        expect(accounts).toHaveLength(ACCOUNT_COUNT);
        expect(accounts[0].toLowerCase()).toBe(derived(0));
        expect(accounts.at(-1)!.toLowerCase()).toBe(derived(ACCOUNT_COUNT - 1));

        // ...and not Hardhat's stock account, which is what it served before.
        expect(accounts[0].toLowerCase()).not.toBe(
          "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        );

        const chainId: string = await connection.provider.request({
          method: "eth_chainId",
          params: [],
        });
        expect(Number(BigInt(chainId))).toBe(LOCAL_CHAIN_ID);

        // Pre-funded means funded: the printed keys have to be able to pay gas.
        const balance: string = await connection.provider.request({
          method: "eth_getBalance",
          params: [accounts[0], "latest"],
        });
        expect(BigInt(balance)).toBe(BigInt(ACCOUNT_BALANCE));
      } finally {
        await connection.close();
      }
    },
    120_000,
  );
});
