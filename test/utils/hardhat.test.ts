import { afterEach, describe, expect, it, vi } from "vitest";
import { silenceHardhatNoise } from "../../src/utils/hardhat";

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
    console.log("Require stack:");

    expect(spies.error).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.log).not.toHaveBeenCalled();
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
