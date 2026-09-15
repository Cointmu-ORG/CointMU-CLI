import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Issue #86 (c): killPort parses a PID out of netstat output and hands it to
// taskkill. These tests pin that the PID is validated as numeric first, that
// both commands are invoked with an argument array (never a shell string), and
// that the existing "free the occupied port" behaviour still works.

const LISTENING_LINE = (port: number, pid: string) =>
  `  TCP    127.0.0.1:${port}     0.0.0.0:0     LISTENING       ${pid}`;

type Call = { cmd: string; args: string[] };

/**
 * Mocks child_process.execFile with a netstat stdout of the caller's choosing
 * and records every invocation.
 */
async function loadKillPort(netstatStdout: string | Error) {
  const calls: Call[] = [];

  vi.resetModules();
  vi.doMock("child_process", () => ({
    execFile: (cmd: string, args: string[], cb: any) => {
      calls.push({ cmd, args });
      if (cmd === "netstat" && netstatStdout instanceof Error) {
        cb(netstatStdout);
        return;
      }
      cb(null, { stdout: cmd === "netstat" ? netstatStdout : "", stderr: "" });
    },
  }));

  const { killPort } = await import("../../src/utils/process");
  return { killPort, calls };
}

describe("killPort", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("child_process");
    vi.resetModules();
  });

  it("kills the process occupying the port using an argument array", async () => {
    const { killPort, calls } = await loadKillPort(
      LISTENING_LINE(8585, "4242"),
    );

    await killPort(8585);

    expect(calls).toEqual([
      { cmd: "netstat", args: ["-ano"] },
      { cmd: "taskkill", args: ["/F", "/PID", "4242"] },
    ]);
  });

  it("refuses to kill anything when the PID is not purely numeric", async () => {
    const { killPort, calls } = await loadKillPort(
      LISTENING_LINE(8585, "4242&calc.exe"),
    );

    await expect(killPort(8585)).rejects.toThrow(/non-numeric PID/);
    expect(calls.some((c) => c.cmd === "taskkill")).toBe(false);
  });

  it("leaves other ports alone", async () => {
    const { killPort, calls } = await loadKillPort(
      LISTENING_LINE(9999, "4242"),
    );

    await killPort(8585);

    expect(calls.some((c) => c.cmd === "taskkill")).toBe(false);
  });

  it("reports the port as free when netstat is unavailable", async () => {
    const { killPort, calls } = await loadKillPort(new Error("ENOENT"));

    await expect(killPort(8585)).resolves.toBeUndefined();
    expect(calls.some((c) => c.cmd === "taskkill")).toBe(false);
  });
});
