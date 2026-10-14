import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  output,
  ADDRESS_B,
  walletsFile,
  sessionFile,
  writeKeySession,
  expectNoKeyLeak,
  setUp,
  tearDown,
} from "../helpers/walletEnv";
import { walletCommands, asked, askingCommands } from "../helpers/walletSut";

beforeEach(setUp);
afterEach(tearDown);

// Issue #194: `login` and `create --login` were deprecated in 1.5.0 and removed
// in 1.6.0. A script still calling them gets one line naming the replacement,
// and nothing else happens first: no prompt, no session read, no new key.

const REMOVED =
  "removed; use wallet save + wallet use (or wallet create --save)";

describe("removed login paths", () => {
  describe.each([
    [["login"]],
    [["login", "extra", "--foo"]],
    [["create", "--login"]],
    [["create", "--login", "--save", "alice"]],
  ])("%j", (argv) => {
    it.each([true, false])(
      "exits 1 with the removal message before anything else (TTY: %s)",
      async (isTTY) => {
        const before = writeKeySession(ADDRESS_B);
        process.stdin.isTTY = isTTY;
        const { ethers } = await import("ethers");
        const createRandom = vi.spyOn(ethers.Wallet, "createRandom");
        const exit = vi
          .spyOn(process, "exit")
          .mockImplementation((() => undefined) as never);
        const { walletCommand } = await askingCommands();

        await walletCommand.parseAsync(argv, { from: "user" });

        expect(exit.mock.calls).toEqual([[1]]);
        expect(vi.mocked(console.error).mock.calls.flat()).toContain(REMOVED);
        expect(console.log).not.toHaveBeenCalled();
        expect(asked).toEqual([]);
        expect(output()).not.toContain("not a saved wallet");
        expect(createRandom).not.toHaveBeenCalled();
        expect(fs.readFileSync(sessionFile(), "utf8")).toBe(before);
        expect(fs.existsSync(walletsFile())).toBe(false);
        expectNoKeyLeak();
      },
    );
  });

  it("leaves both out of the help", async () => {
    const { walletCommand } = await walletCommands();
    const create = walletCommand.commands.find((c) => c.name() === "create");

    expect(walletCommand.helpInformation()).not.toMatch(/login/i);
    expect(create?.helpInformation()).toContain("--save <name>");
    expect(create?.helpInformation()).not.toMatch(/login/i);
  });

  // One check for every hint, present and future: the only code (not comment)
  // lines in src/ that may say "login" are the stub's own.
  it("no hint in src/ names login", () => {
    const STUB = [
      /^const REMOVED_LOGIN =$/,
      /\.command\("login", \{ hidden: true \}\)/,
      /new Option\("--login"\)/,
      /fail\("wallet login"/,
      /options\.login/,
      /login\?: boolean/,
    ];
    const src = path.resolve(__dirname, "../../src");
    const offenders = fs
      .readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) =>
        fs
          .readFileSync(path.join(src, file), "utf8")
          .split("\n")
          .map((line, i) => ({ at: `${file}:${i + 1}`, line: line.trim() }))
          .filter(({ line }) => /login/i.test(line))
          .filter(({ line }) => !/^(\/\/|\/?\*)/.test(line))
          .filter(({ line }) => !STUB.some((re) => re.test(line))),
      );

    expect(offenders).toEqual([]);
  });
});
