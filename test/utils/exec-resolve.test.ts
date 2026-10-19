import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResolvedCommand } from "../../src/utils/npmCommand";

// run() with the resolver replaced, to show it spawns whatever the resolver
// returns. On Linux the real resolver passes npm through, so without this the
// win32 wiring would only ever be exercised on a Windows runner.

const ODD_ARGS = [
  "a&b|c^%PATH%",
  "x y",
  'q"q',
  "",
  "'s'",
  "`id`",
  "$HOME",
  "\\\\srv\\a b\\",
];

// Not npm itself: a run() that skipped the resolver would otherwise start a real
// `npm install` in the repo.
const UNRESOLVED = "cmu-resolved-only";

/** A node child that exits 0 only when it receives `expected` verbatim. */
function argvCheck(expected: string[]): ResolvedCommand {
  const script =
    `process.exit(JSON.stringify(process.argv.slice(1)) === ` +
    `${JSON.stringify(JSON.stringify(expected))} ? 0 : 9)`;
  return { file: process.execPath, args: ["-e", script, ...expected] };
}

describe("run through the resolver", () => {
  let resolveCommand: ReturnType<typeof vi.fn>;
  let run: typeof import("../../src/utils/exec").run;

  beforeEach(async () => {
    vi.resetModules();
    resolveCommand = vi.fn();
    vi.doMock("../../src/utils/npmCommand", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/utils/npmCommand")>()),
      resolveCommand,
    }));
    ({ run } = await import("../../src/utils/exec"));
  });

  afterEach(() => {
    vi.doUnmock("../../src/utils/npmCommand");
    vi.resetModules();
  });

  it("asks the resolver for the command and spawns what it returns", async () => {
    resolveCommand.mockReturnValue(argvCheck(["install", "ethers"]));

    await expect(
      run(UNRESOLVED, ["install", "ethers"]),
    ).resolves.toBeUndefined();
    expect(resolveCommand).toHaveBeenCalledWith(UNRESOLVED, [
      "install",
      "ethers",
    ]);
  });

  it("hands odd arguments to the resolved child unchanged", async () => {
    resolveCommand.mockReturnValue(argvCheck(ODD_ARGS));

    await expect(run(UNRESOLVED, ODD_ARGS)).resolves.toBeUndefined();
  });

  it("rejects with the resolver's error without spawning anything", async () => {
    const { NpmEntryNotFoundError } =
      await import("../../src/utils/npmCommand");
    const notFound = new NpmEntryNotFoundError("npm-cli.js", ["A", "B"]);
    resolveCommand.mockImplementation(() => {
      throw notFound;
    });

    await expect(run(UNRESOLVED, ["audit"])).rejects.toBe(notFound);
  });
});
