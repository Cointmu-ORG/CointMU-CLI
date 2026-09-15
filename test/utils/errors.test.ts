import { afterEach, describe, expect, it, vi } from "vitest";

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
