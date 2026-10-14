import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import { decryptSessionKey } from "../../src/utils/session";
import {
  PASSWORD,
  output,
  clearLogged,
  readSession,
  writeSession,
  KEY_B,
  ADDRESS_A,
  ADDRESS_B,
  walletsFile,
  readWallets,
  sessionFile,
  writeKeySession,
  expectNoKeyLeak,
  setUp,
  tearDown,
} from "../helpers/walletEnv";
import {
  walletCommands,
  asked,
  questions,
  askingCommands,
  ctrlC,
  save,
} from "../helpers/walletSut";

beforeEach(setUp);
afterEach(tearDown);

// #182: login, create --login and use replaced a session whose key was saved
// nowhere else without asking. `use`, the one writer left since #194, must ask
// first - before any prompt for a password - and leave the file alone unless
// told yes. A session from 1.5.x `login` is exactly such a key.
describe("replacing an unsaved session", () => {
  const paths = {
    use: {
      answers: { password: PASSWORD },
      run: async (answers: Record<string, unknown>) =>
        (await askingCommands(answers)).runWalletUse("deployer"),
    },
  };

  /**
   * Makes any session write fail the test loudly, and returns the spy: a
   * refusal must not reach writeSessionFile at all.
   */
  function blockSessionWrites() {
    const write = vi.fn(async () => {
      throw new Error("writeSessionFile must not be called");
    });
    vi.doMock("../../src/utils/session", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/utils/session")>()),
      writeSessionFile: write,
    }));
    return write;
  }

  /** The refusal left the session byte-identical, with no temp file. */
  function expectUntouched(
    before: string,
    write: ReturnType<typeof blockSessionWrites>,
  ): void {
    expect(write).not.toHaveBeenCalled();
    expect(fs.readFileSync(sessionFile(), "utf8")).toBe(before);
    expectNoKeyLeak();
  }

  beforeEach(async () => {
    await save("deployer"); // KEY, the key use writes
    clearLogged();
  });

  describe.each(Object.keys(paths) as (keyof typeof paths)[])(
    "%s",
    (pathName) => {
      const { answers, run } = paths[pathName];

      it("asks before any other prompt, and replaces the session on yes", async () => {
        writeKeySession(ADDRESS_B);

        await run({ ...answers, replace: true });

        expect(asked[0]).toBe("replace");
        expect(questions[0]).toMatchObject({
          type: "confirm",
          message: "Replace it anyway?",
          default: false,
        });
        expect(asked.length).toBeGreaterThan(1);
        expect(output()).toContain(
          `warning:\x1b[0m .cmu-session holds the key for ${ADDRESS_B}, which is not a saved wallet.`,
        );
        expect(output()).toContain("cannot recover it");
        expect(output()).toContain("`cmu wallet save <name> --session`");
        const session = readSession();
        expect(session.address).not.toBe(ADDRESS_B);
        expectNoKeyLeak([decryptSessionKey(PASSWORD, session)]);
      });

      it.each([
        [
          "no",
          false,
          `aborted: .cmu-session was not changed; it still holds ${ADDRESS_B}.`,
        ],
        ["Ctrl-C", ctrlC(), "force closed the prompt"],
      ])(
        "leaves the session untouched on %s, without prompting for a secret",
        async (_, replace, message) => {
          const before = writeKeySession(ADDRESS_B);
          const write = blockSessionWrites();

          await expect(run({ ...answers, replace })).rejects.toThrow(message);

          expect(asked).toEqual(["replace"]);
          expectUntouched(before, write);
        },
      );

      it("refuses without a terminal, before any prompt", async () => {
        const before = writeKeySession(ADDRESS_B);
        const write = blockSessionWrites();
        process.stdin.isTTY = false;

        const error = await run(answers).catch((e: Error) => e);

        expect((error as Error).message).toContain(
          "cannot prompt for confirmation in a non-interactive session",
        );
        expect((error as Error).message).toContain(
          "`cmu wallet save <name> --session`",
        );
        expect(asked).toEqual([]);
        expectUntouched(before, write);
      });

      it.each([
        ["there is no session", async () => {}],
        [
          "the session's key is saved",
          async () => {
            writeKeySession(ADDRESS_B);
            await save("b", KEY_B);
          },
        ],
        [
          "the session's key is saved, address in another case",
          async () => {
            writeKeySession(ADDRESS_B.toLowerCase());
            await save("b", KEY_B);
          },
        ],
        [
          "the session is corrupt",
          async () => fs.writeFileSync(sessionFile(), "{ not json"),
        ],
        ["the session holds no key", async () => writeSession("local")],
        [
          "the session predates AES-GCM",
          async () => writeKeySession(ADDRESS_B, KEY_B, { authTag: undefined }),
        ],
      ])("replaces silently when %s", async (_, setup) => {
        await setup();

        await run(answers); // no `replace` answer: asking would throw

        expect(asked).not.toContain("replace");
        expect(output()).not.toContain("not a saved wallet");
        const session = readSession();
        expect(session.address).not.toBe(ADDRESS_B);
        expect(decryptSessionKey(PASSWORD, session)).toMatch(
          /^0x[0-9a-f]{64}$/,
        );
      });

      it("refuses on an unreadable store, since the key's safety is unknown", async () => {
        const before = writeKeySession(ADDRESS_B);
        fs.writeFileSync(walletsFile(), "{");
        const write = blockSessionWrites();

        await expect(run(answers)).rejects.toThrow("not a valid wallets file");

        expect(asked).toEqual([]);
        expectUntouched(before, write);
      });
    },
  );

  describe("use, after yes", () => {
    it("leaves the session untouched on a wrong password", async () => {
      const before = writeKeySession(ADDRESS_B);
      const write = blockSessionWrites();

      await expect(
        paths.use.run({ replace: true, password: "wrong password 1" }),
      ).rejects.toThrow("wrong password for wallet 'deployer'");

      expect(asked).toEqual(["replace", "password"]);
      expectUntouched(before, write);
    });

    it("leaves the session untouched when the decrypted address does not match", async () => {
      const before = writeKeySession(ADDRESS_B);
      const file = readWallets();
      file.wallets[0].address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
      fs.writeFileSync(walletsFile(), JSON.stringify(file));
      const write = blockSessionWrites();

      await expect(
        paths.use.run({ replace: true, password: PASSWORD }),
      ).rejects.toThrow("has been modified");

      expect(asked).toEqual(["replace", "password"]);
      expectUntouched(before, write);
    });

    it("does not leak the key through --verbose after a refusal", async () => {
      writeKeySession(ADDRESS_B);
      const { fail } = await import("../../src/utils/errors");
      vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

      await paths.use
        .run({ replace: false, password: PASSWORD })
        .catch(fail("wallet use", { verbose: true }));

      expect(output()).toContain("wallet use failed");
      expect(output()).toContain("aborted");
      expectNoKeyLeak();
    });

    it("stays silent once the session key was kept with save --session", async () => {
      writeKeySession(ADDRESS_B);
      process.stdin.isTTY = false;
      await (await walletCommands()).runWalletSave("keep", { session: true });
      process.stdin.isTTY = true;

      await paths.use.run({ password: PASSWORD });

      expect(asked).toEqual(["password"]);
      expect(readSession().address).toBe(ADDRESS_A);
    });
  });
});
