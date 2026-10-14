import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { stripVTControlCharacters } from "util";
import {
  tmpDir,
  output,
  readSession,
  writeSession,
  KEY_B,
  ADDRESS_A,
  ADDRESS_B,
  expectNoKeyLeak,
  setUp,
  tearDown,
} from "../helpers/walletEnv";
import { asked, askingCommands } from "../helpers/walletSut";
import {
  TO,
  sendTransaction,
  type Chain,
  mockChain,
  YES_ANSWERS,
  transfer,
  transferSetUp,
} from "../helpers/walletTransfer";

beforeEach(setUp);
afterEach(tearDown);

describe("wallet transfer", () => {
  beforeEach(transferSetUp);

  describe("environment", () => {
    it("fails clearly when the node is down, without prompting", async () => {
      await mockChain({
        refuse: true,
        networkError: new Error("connect ECONNREFUSED"),
      });
      await expect(transfer()).rejects.toThrow("unreachable");
      expect(asked).toEqual([]);
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    // The network here comes from .cmu-networks.json, not a cmu.config, so the
    // hint must send the user to `network save`, never to a config file.
    it("points a saved network with no url at network save, not a config file", async () => {
      fs.writeFileSync(
        path.join(tmpDir, ".cmu-networks.json"),
        JSON.stringify([{ name: "local", rpcUrl: "" }]),
      );
      await mockChain({ refuse: true });

      const error = await transfer().catch((e: Error) => e);

      expect(stripVTControlCharacters((error as Error).message)).toBe(
        "network 'local' has no url.\n" +
          "hint: re-save it with `cmu network save <url> --name local`.",
      );
      expect(asked).toEqual([]);
    });

    it("fails without a session", async () => {
      fs.rmSync(path.join(tmpDir, ".cmu-session"));
      await mockChain({ refuse: true });
      await expect(transfer()).rejects.toThrow("no active session");
      expect(asked).toEqual([]);
    });

    it("fails on a session without an encrypted key", async () => {
      writeSession("local");
      await mockChain({ refuse: true });
      await expect(transfer()).rejects.toThrow("holds no encrypted key");
      expect(asked).toEqual([]);
    });

    it("ignores PRIVATE_KEY, says so, and never prints its value", async () => {
      vi.stubEnv("PRIVATE_KEY", KEY_B);
      await mockChain();

      await transfer();

      expect(output()).toContain("PRIVATE_KEY is set");
      expect(sendTransaction.mock.contexts[0]).toMatchObject({
        address: ADDRESS_A,
      });
      expect(output()).toContain(`From    : ${ADDRESS_A}`);
      expectNoKeyLeak();
    });

    it("refuses a session whose address does not match its key", async () => {
      const session = readSession();
      session.address = ADDRESS_B;
      fs.writeFileSync(
        path.join(tmpDir, ".cmu-session"),
        JSON.stringify(session),
      );
      await mockChain({ refuse: true });

      await expect(transfer()).rejects.toThrow("has been modified");
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  describe("no key or password leaks", () => {
    beforeEach(() => {
      vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    });

    it.each([
      ["a wrong password", {}, { password: "wrong password 1", proceed: true }],
      [
        "a failed send",
        { sendError: new Error("socket hang up") },
        YES_ANSWERS,
      ],
    ])("through --verbose after %s", async (_, chain, answers) => {
      await mockChain(chain as Partial<Chain>);
      const { fail } = await import("../../src/utils/errors");
      const { runWalletTransfer } = await askingCommands(answers);

      await runWalletTransfer(TO, "1.5").catch(
        fail("wallet transfer", { verbose: true }),
      );

      expect(output()).toContain("wallet transfer failed");
      expectNoKeyLeak();
    });
  });
});
