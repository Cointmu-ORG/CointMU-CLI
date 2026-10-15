import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

// Issue #228: a per-network coin symbol, set on `network save`. Same harness
// as network.test.ts, and the same describe names, so the tests read as one
// suite.

describe("networkCommand wiring", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-network-symbol-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    // networkStorage keys .cmu-networks.json off os.homedir(), which reads HOME
    // on POSIX and USERPROFILE on Windows. Without this the suite would read and
    // write the developer's real saved networks.
    vi.stubEnv("HOME", tmpDir);
    vi.stubEnv("USERPROFILE", tmpDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function loadCommand() {
    vi.resetModules();
    return (await import("../../src/commands/network")).networkCommand;
  }

  /** Runs the command exactly as the CLI would, argv and all. */
  async function run(...argv: string[]) {
    const command = await loadCommand();
    await command.parseAsync(argv, { from: "user" });
  }

  describe("--symbol", () => {
    const networksFile = () => path.join(tmpDir, ".cmu-networks.json");
    const saved = () => JSON.parse(fs.readFileSync(networksFile(), "utf8"));

    it("is declared on `network save` only, with no short flag", async () => {
      const command = await loadCommand();
      const save: any = command.commands.find((c: any) => c.name() === "save");
      const symbol = save.options.find((o: any) => o.long === "--symbol");

      expect(symbol).toBeDefined();
      expect(symbol.short).toBeUndefined();
      expect(command.options.some((o: any) => o.long === "--symbol")).toBe(
        false,
      );
    });

    it("stores the symbol and says so", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      await run(
        "save",
        "http://127.0.0.1:9000",
        "--name",
        "kampus",
        "--symbol",
        "CMU",
      );

      expect(saved()).toContainEqual({
        name: "kampus",
        rpcUrl: "http://127.0.0.1:9000",
        symbol: "CMU",
      });
      expect((log as any).mock.calls.flat().join("\n")).toContain(
        "Saved network 'kampus' (http://127.0.0.1:9000, symbol CMU)",
      );
    });

    it("keeps the old message and writes no symbol key without the flag", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      await run("save", "http://127.0.0.1:9000", "--name", "kampus");

      expect(saved()).toContainEqual({
        name: "kampus",
        rpcUrl: "http://127.0.0.1:9000",
      });
      expect((log as any).mock.calls.flat()).toContain(
        "Saved network 'kampus' (http://127.0.0.1:9000)",
      );
    });

    it("says which symbol an update without --symbol kept", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await run(
        "save",
        "http://127.0.0.1:9000",
        "--name",
        "kampus",
        "--symbol",
        "tCMU",
      );
      log.mockClear();

      await run("save", "http://127.0.0.1:9001", "--name", "kampus");

      expect(saved()).toContainEqual({
        name: "kampus",
        rpcUrl: "http://127.0.0.1:9001",
        symbol: "tCMU",
      });
      expect((log as any).mock.calls.flat()).toContain(
        "Saved network 'kampus' (http://127.0.0.1:9001, symbol tCMU kept)",
      );
    });

    it("says the seeded local network kept CMU when only its URL is saved", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      await run("save", "http://127.0.0.1:8585", "--name", "local");

      expect((log as any).mock.calls.flat()).toContain(
        "Saved network 'local' (http://127.0.0.1:8585, symbol CMU kept)",
      );
    });

    it("keeps the stored symbol case as typed", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});

      await run(
        "save",
        "http://127.0.0.1:9000",
        "--name",
        "kampus",
        "--symbol",
        "tCMU",
      );

      expect(saved()).toContainEqual(
        expect.objectContaining({ name: "kampus", symbol: "tCMU" }),
      );
    });

    it.each([
      ["a dash", "C-M"],
      ["12 characters", "ABCDEFGHIJKL"],
      ["an empty value", ""],
      ["an emoji", "CMU🚀"],
    ])(
      "rejects a symbol with %s before the file is written",
      async (_l, symbol) => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        await run("list"); // seeds the file
        const before = fs.readFileSync(networksFile());
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const exit = vi.spyOn(process, "exit").mockImplementation((() => {
          throw new Error("exited");
        }) as any);

        await expect(
          run(
            "save",
            "http://127.0.0.1:9000",
            "--name",
            "kampus",
            "--symbol",
            symbol,
          ),
        ).rejects.toThrow("exited");

        const output = (error as any).mock.calls.flat().join("\n");
        expect(output).toContain(`invalid symbol '${symbol}'`);
        expect(output).toContain("1-11 letters or digits");
        expect(exit).toHaveBeenCalledWith(1);
        expect(fs.readFileSync(networksFile()).equals(before)).toBe(true);
      },
    );

    it("leaves the deprecated --save writing what it always wrote", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});

      await run("--save", "http://127.0.0.1:9000", "--name", "kampus");

      expect(saved()).toContainEqual({
        name: "kampus",
        rpcUrl: "http://127.0.0.1:9000",
      });
    });

    it.each([
      ["a freshly seeded local", null, "CMU"],
      [
        "a network saved before symbols",
        [{ name: "local", rpcUrl: "http://127.0.0.1:8585" }],
        "ETH",
      ],
    ])("`network info` shows the symbol of %s", async (_l, file, symbol) => {
      if (file) fs.writeFileSync(networksFile(), JSON.stringify(file));
      fs.writeFileSync(
        path.join(tmpDir, ".cmu-session"),
        JSON.stringify({ address: "0xTest", activeNetwork: "local" }),
      );
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      await run("info");

      expect((log as any).mock.calls.flat()).toContain(
        `Symbol       : ${symbol}`,
      );
    });
  });
});
