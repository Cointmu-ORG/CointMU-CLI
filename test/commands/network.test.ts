import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { isValidRpcUrl } from "../../src/commands/network";

// Issue #86 (a): `cmu network --save` persisted whatever string it was given.

describe("isValidRpcUrl", () => {
  it.each([
    "http://127.0.0.1:8585",
    "https://rpc.example.com",
    "https://rpc.example.com:8585/path",
  ])("accepts %s", (url) => {
    expect(isValidRpcUrl(url)).toBe(true);
  });

  it.each([
    ["a bare word", "notaurl"],
    ["a host with no scheme", "127.0.0.1:8585"],
    ["an empty string", ""],
    ["whitespace", "   "],
  ])("rejects %s", (_label, url) => {
    expect(isValidRpcUrl(url)).toBe(false);
  });

  it.each([
    ["file", "file:///etc/passwd"],
    ["javascript", "javascript:alert(1)"],
    ["ws", "ws://127.0.0.1:8585"],
    ["wss", "wss://rpc.example.com"],
  ])("rejects the %s scheme, which JsonRpcProvider cannot speak", (_l, url) => {
    expect(isValidRpcUrl(url)).toBe(false);
  });
});

// The --save/--use/--list/--delete flags became subcommands in 1.4.0. The flags
// still run the same handlers behind a deprecation notice until 2.0.0, so these
// pin the mapping rather than the wording.

describe("networkCommand wiring", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-network-"));
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

  it("exposes save, list, use and delete as real subcommands", async () => {
    const command = await loadCommand();
    const names = command.commands.map((c: any) => c.name());

    expect(names).toEqual(
      expect.arrayContaining(["save", "list", "use", "delete", "info", "ping"]),
    );
  });

  it("takes the url positionally on `network save`", async () => {
    const command = await loadCommand();
    const save: any = command.commands.find((c: any) => c.name() === "save");

    expect(save.registeredArguments.map((a: any) => a.name())).toEqual(["url"]);
    expect(save.options.some((o: any) => o.long === "--name")).toBe(true);
  });

  it("refuses to save a url with no name, and says how to give one", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exited");
    }) as any);

    await expect(run("save", "http://127.0.0.1:9000")).rejects.toThrow(
      "exited",
    );

    const output = (error as any).mock.calls.flat().join("\n");
    expect(output).toContain("--name is required");
    expect(output).toContain("hint:");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("saves through the subcommand with no deprecation notice", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await run("save", "http://127.0.0.1:9000", "--name", "staging");

    expect(warn).not.toHaveBeenCalled();
    expect((log as any).mock.calls.flat().join("\n")).toContain(
      "Saved network 'staging'",
    );
  });

  it("rejects a non-http endpoint before it reaches storage", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exited");
    }) as any);

    await expect(
      run("save", "ws://127.0.0.1:9000", "--name", "bad"),
    ).rejects.toThrow("exited");
    expect(exit).toHaveBeenCalledWith(1);
  });

  // ping/use/delete each did their own lookup in .cmu-networks.json; they now
  // go through getDynamicNetwork(), and delete through deleteNetwork()'s false.
  it.each([["ping"], ["use"], ["delete"]])(
    "`network %s` refuses a network that is not saved",
    async (sub) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("exited");
      }) as any);

      await expect(run(sub, "ghost")).rejects.toThrow("exited");

      const output = (error as any).mock.calls.flat().join("\n");
      expect(output).toContain("network 'ghost' is not saved");
      expect(output).toContain("cmu network list");
      expect(exit).toHaveBeenCalledWith(1);
    },
  );

  it("deletes a saved network that is not the active one", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await run("save", "http://127.0.0.1:9000", "--name", "staging");

    await run("delete", "staging");

    const saved = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".cmu-networks.json"), "utf8"),
    );
    expect(saved.map((n: any) => n.name)).toEqual(["local"]);
  });

  it.each([
    [
      ["--save", "http://127.0.0.1:9000", "--name", "staging"],
      "--save",
      "save",
    ],
    [["--use", "staging"], "--use", "use"],
    [["--list"], "--list", "list"],
    [["--delete", "staging"], "--delete", "delete"],
  ])(
    "%s still runs, over a deprecation notice naming its replacement",
    async (argv, flag, replacement) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      await run(...(argv as string[]));

      const output = (warn as any).mock.calls.flat().join("\n");
      expect(output).toContain("warning:");
      expect(output).toContain(`\`cmu network ${flag}\` is deprecated`);
      expect(output).toContain("2.0.0");
      expect(output).toContain("hint:");
      expect(output).toContain(`cmu network ${replacement}`);
    },
  );

  it("lists without any deprecation notice when no flag is given", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await run();

    expect(warn).not.toHaveBeenCalled();
    expect((log as any).mock.calls.flat().join("\n")).toContain(
      "Saved networks",
    );
  });
});
