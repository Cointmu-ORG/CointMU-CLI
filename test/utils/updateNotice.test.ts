import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { readPkg } from "../../src/utils/pkg";

// update-notifier is mocked: nothing here reaches the registry or spawns its
// background check. `loaded` records whether cmu imported the package at
// all, so the commands that must stay fast prove they never load it.

const realStdoutTTY = process.stdout.isTTY;
const realStderrTTY = process.stderr.isTTY;

let loaded: boolean;
let created: unknown[];
let notified: unknown[];

beforeEach(() => {
  vi.resetModules();
  loaded = false;
  created = [];
  notified = [];
  vi.doMock("update-notifier", () => {
    loaded = true;
    return {
      default: (options: unknown) => {
        created.push(options);
        return {
          notify: (notifyOptions: unknown) => {
            notified.push(notifyOptions);
          },
        };
      },
    };
  });
  vi.stubEnv("CMU_NO_UPDATE_CHECK", undefined);
  vi.stubEnv("NO_UPDATE_NOTIFIER", undefined);
  process.stdout.isTTY = true;
  process.stderr.isTTY = true;
  process.exitCode = undefined;
});

afterEach(() => {
  process.stdout.isTTY = realStdoutTTY;
  process.stderr.isTTY = realStderrTTY;
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.doUnmock("update-notifier");
  vi.restoreAllMocks();
});

/** A root program shaped like src/index.ts, every action a no-op. */
async function cli(...argv: string[]): Promise<void> {
  const { registerUpdateNotice } = await import("../../src/utils/updateNotice");
  const program = new Command("cmu").exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  const noop = async () => {};
  for (const name of [
    "create",
    "compile",
    "test",
    "deploy",
    "console",
    "explorer",
    "audit",
    "update",
    "version",
  ]) {
    program.command(name).action(noop);
  }
  for (const [group, subs] of [
    ["network", ["list"]],
    // `wallet create` shares its name with the top-level `create`.
    ["wallet", ["list", "create"]],
    ["node", ["start"]],
    ["mine", ["start"]],
  ] as const) {
    const parent = program.command(group);
    for (const sub of subs) parent.command(sub).action(noop);
  }
  program.command("broken").action(async () => {
    throw new Error("compile failed");
  });
  program.command("exits-1").action(async () => {
    process.exitCode = 1;
  });
  registerUpdateNotice(program);
  await program.parseAsync(argv, { from: "user" });
}

const NOTICE =
  "Update available \x1b[2m{currentVersion}\x1b[0m → \x1b[32m{latestVersion}\x1b[0m\nRun \x1b[36mcmu update\x1b[0m to update";

describe("update notice", () => {
  it.each([["create"], ["compile"], ["test"]])(
    "is shown after `cmu %s` succeeds",
    async (command) => {
      await cli(command);

      expect(created).toEqual([
        { pkg: { name: "cointmu-cli", version: readPkg().version } },
      ]);
      expect(notified).toEqual([{ defer: false, message: NOTICE }]);
    },
  );

  it.each([
    "deploy",
    "console",
    "explorer",
    "audit",
    "update",
    "version",
    "network list",
    "wallet list",
    "wallet create",
    "node start",
    "mine start",
  ])("is never loaded for `cmu %s`", async (command) => {
    await cli(...command.split(" "));

    expect(loaded).toBe(false);
    expect(notified).toEqual([]);
  });

  it("is not shown for --help", async () => {
    await expect(cli("compile", "--help")).rejects.toThrow("(outputHelp)");

    expect(loaded).toBe(false);
  });

  it("is not shown when the command fails", async () => {
    await expect(cli("broken")).rejects.toThrow("compile failed");

    expect(loaded).toBe(false);
  });

  it("is not shown when the command set a failing exit code", async () => {
    await cli("exits-1");
    expect(loaded).toBe(false);

    process.exitCode = 1;
    await cli("compile");
    expect(loaded).toBe(false);
  });

  it.each([
    ["CMU_NO_UPDATE_CHECK", "1"],
    ["NO_UPDATE_NOTIFIER", "1"],
    ["NO_UPDATE_NOTIFIER", ""],
  ])("is turned off by %s=%j", async (name, value) => {
    vi.stubEnv(name, value);

    await cli("compile");

    expect(loaded).toBe(false);
  });

  it.each([
    ["stdout", "stdout" as const],
    ["stderr", "stderr" as const],
  ])("is not shown when %s is not a terminal", async (_, stream) => {
    process[stream].isTTY = false;

    await cli("compile");

    expect(loaded).toBe(false);
  });
});
