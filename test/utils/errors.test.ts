import { afterEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import { serverError } from "../helpers/ethersServerError";

// Issue #87 (b): `--verbose` printed raw error objects, so stack frames and
// file-system messages leaked the absolute path of the user's home directory.

const HOME = "/home/tester";

/**
 * Loads the helper with a fixed homedir, so the fixtures below do not depend
 * on the machine the suite runs on.
 */
async function loadWithHome(home: string) {
  vi.doMock("os", () => ({
    homedir: () => home,
    default: { homedir: () => home },
  }));
  return import("../../src/utils/errors");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("os");
});

describe("scrubHomeDir", () => {
  it("replaces a home path in the middle of a message", async () => {
    const { scrubHomeDir } = await loadWithHome(HOME);
    expect(
      scrubHomeDir(
        `ENOENT: no such file or directory, open '${HOME}/dapp/cmu.config.ts'`,
      ),
    ).toBe("ENOENT: no such file or directory, open '~/dapp/cmu.config.ts'");
  });

  it("replaces every occurrence across a multi-line stack trace", async () => {
    const { scrubHomeDir } = await loadWithHome(HOME);
    const stack = [
      `Error: connect ECONNREFUSED 127.0.0.1:8545`,
      `    at runDeploy (${HOME}/dapp/node_modules/cointmu-cli/dist/index.js:1:1)`,
      `    at loadConfig (${HOME}/dapp/cmu.config.ts:4:20)`,
      `    at Object.<anonymous> (${HOME}/dapp/deploy/00_deploy.ts:2:1)`,
    ].join("\n");

    const scrubbed = scrubHomeDir(stack);

    expect(scrubbed).not.toContain(HOME);
    expect(scrubbed.match(/~\/dapp/g)).toHaveLength(3);
    expect(scrubbed).toContain("Error: connect ECONNREFUSED 127.0.0.1:8545");
  });

  it("leaves text without a home path untouched", async () => {
    const { scrubHomeDir } = await loadWithHome(HOME);
    const text = "error: invalid --to value\n    at /usr/lib/node/foo.js:1:1";
    expect(scrubHomeDir(text)).toBe(text);
  });

  it.each(["", "/"])(
    "leaves text untouched when homedir is %j, rather than mangling separators",
    async (home) => {
      const { scrubHomeDir } = await loadWithHome(home);
      const text = "at /home/tester/dapp/index.ts:1:1";
      expect(scrubHomeDir(text)).toBe(text);
    },
  );
});

describe("printCliError", () => {
  it("prints the scrubbed stack in verbose mode", async () => {
    const { printCliError } = await loadWithHome(HOME);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const error = new Error("deploy failed");
    error.stack = `Error: deploy failed\n    at runDeploy (${HOME}/dapp/x.ts:1:1)`;
    printCliError(error, true);

    const output = spy.mock.calls.flat().join("\n");
    expect(output).toContain("at runDeploy (~/dapp/x.ts:1:1)");
    expect(output).not.toContain(HOME);
  });

  it("prints only the scrubbed message when verbose is off", async () => {
    const { printCliError } = await loadWithHome(HOME);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const error = new Error(`ENOENT, open '${HOME}/dapp/cmu.config.ts'`);
    error.stack = `Error\n    at runDeploy (${HOME}/dapp/x.ts:1:1)`;
    printCliError(error, false);

    const output = spy.mock.calls.flat().join("\n");
    expect(output).toBe("ENOENT, open '~/dapp/cmu.config.ts'");
    expect(output).not.toContain("at runDeploy");
  });

  it("handles a thrown non-Error value", async () => {
    const { printCliError } = await loadWithHome(HOME);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    printCliError(`failed in ${HOME}/dapp`, false);

    expect(spy.mock.calls.flat().join("\n")).toBe("failed in ~/dapp");
  });
});

// Issue #213: ethers puts the request URL, credentials included, into its
// error message and its `info`, and a wrapping error carries it on as `cause`.

describe("printCliError and RPC credentials", () => {
  const CREDS_URL = "http://user:pw@127.0.0.1:18546/rpc?k=1";
  const MASKED = "http://user:***@127.0.0.1:18546/rpc?k=***";
  const PLAIN_URL = "http://127.0.0.1:18546/rpc";

  async function printed(error: unknown, verbose: boolean) {
    const { printCliError } = await loadWithHome(HOME);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    printCliError(error, verbose);
    return spy.mock.calls.flat().join("\n");
  }

  /** Wrapped the way sendMiner() rethrows a node error it does not handle. */
  const wrapped = (url: string) =>
    new Error("network 'creds' has no miner_start RPC", {
      cause: serverError(url),
    });

  it.each([
    ["the message", false, () => serverError(CREDS_URL)],
    ["the inspected error and its info", true, () => serverError(CREDS_URL)],
    ["the cause's message and info", true, () => wrapped(CREDS_URL)],
    ["a non-Error value", false, () => `failed: ${CREDS_URL}`],
  ])("masks credentials in %s", async (_label, verbose, make) => {
    const output = await printed(make(), verbose);

    expect(output).not.toContain("user:pw");
    expect(output).not.toContain("k=1");
    expect(output).toContain(MASKED);
  });

  it("shows the cause's info under --verbose, masked rather than dropped", async () => {
    const output = await printed(wrapped(CREDS_URL), true);

    expect(output).toContain("[cause]");
    expect(output).toContain(`requestUrl: '${MASKED}'`);
    expect(output).toContain("responseStatus: '401 Unauthorized'");
  });

  it("prints a URL without credentials as it was", async () => {
    const output = await printed(serverError(PLAIN_URL), false);

    expect(output).toContain(`"requestUrl": "${PLAIN_URL}"`);
    expect(output).not.toContain("***");
  });

  it("prints a URL without credentials as it was under --verbose", async () => {
    const output = await printed(wrapped(PLAIN_URL), true);

    expect(output).toContain(`requestUrl: '${PLAIN_URL}'`);
    expect(output).not.toContain("***");
  });
});

// Every command used to end with its own copy of "print a banner, print the
// error, exit 1". fail() is that ending, once.

describe("fail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function capture() {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`exit:${code}`);
    }) as never);
    return { error, exit };
  }

  it("names the command that failed, then prints the error", async () => {
    const { fail } = await import("../../src/utils/errors");
    const { error } = capture();

    expect(() => fail("network info")(new Error("boom"))).toThrow("exit:1");

    const printed = error.mock.calls.flat().join("\n");
    expect(printed).toMatch(/error:.*network info failed/);
    expect(printed).toMatch(/boom/);
  });

  it("exits non-zero", async () => {
    const { fail } = await import("../../src/utils/errors");
    const { exit } = capture();

    expect(() => fail("deploy")(new Error("boom"))).toThrow();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("prints only the message unless verbose is set", async () => {
    const { fail } = await import("../../src/utils/errors");
    const { error } = capture();
    const err = new Error("boom");
    err.stack = "Error: boom\n    at somewhere (/tmp/x.ts:1:1)";

    expect(() => fail("test", {})(err)).toThrow();

    expect(error.mock.calls.flat().join("\n")).not.toMatch(/at somewhere/);
  });

  it("prints the inspected error when verbose is set", async () => {
    const { fail } = await import("../../src/utils/errors");
    const { error } = capture();
    const err = new Error("boom");
    err.stack = "Error: boom\n    at somewhere (/tmp/x.ts:1:1)";

    expect(() => fail("test", { verbose: true })(err)).toThrow();

    expect(error.mock.calls.flat().join("\n")).toMatch(/at somewhere/);
  });

  it("scrubs the home directory out of what it prints", async () => {
    const { fail } = await import("../../src/utils/errors");
    const { error } = capture();
    const home = os.homedir();

    expect(() =>
      fail("compile")(new Error(`ENOENT ${home}/p/x.sol`)),
    ).toThrow();

    const printed = error.mock.calls.flat().join("\n");
    expect(printed).toContain("~/p/x.sol");
    expect(printed).not.toContain(home);
  });
});
