import { describe, expect, it } from "vitest";
import { realpathSync } from "fs";
import { tmpdir } from "os";
import { CommandExitError, run } from "../../src/utils/exec";

// The fixtures are the Node already running this suite, so there is nothing to
// install and nothing platform-specific to keep in the repo.

describe("run", () => {
  it("resolves when the child exits 0", async () => {
    await expect(run(process.execPath, ["-e", ""])).resolves.toBeUndefined();
  });

  it("rejects with the exit code, under the label the caller gave", async () => {
    await expect(
      run(process.execPath, ["-e", "process.exit(3)"], {
        label: "01_deploy.js",
      }),
    ).rejects.toThrow("01_deploy.js exited with code 3");
  });

  it("rejects a non-zero exit as a CommandExitError carrying the code", async () => {
    const exit = run(process.execPath, ["-e", "process.exit(3)"]);

    await expect(exit).rejects.toBeInstanceOf(CommandExitError);
    await expect(exit).rejects.toMatchObject({ exitCode: 3 });
  });

  // Windows has no signals to send a process; it is only terminated.
  it.skipIf(process.platform === "win32")(
    "rejects a child killed by a signal as a CommandExitError with no code",
    async () => {
      const killed = run(
        process.execPath,
        ["-e", "process.kill(process.pid, 'SIGTERM')"],
        { label: "test run" },
      );

      await expect(killed).rejects.toBeInstanceOf(CommandExitError);
      await expect(killed).rejects.toMatchObject({
        exitCode: null,
        message: "test run exited with code null",
      });
    },
  );

  it("names the command itself when there is no label", async () => {
    await expect(
      run(process.execPath, ["-e", "process.exit(1)"]),
    ).rejects.toThrow(`${process.execPath} exited with code 1`);
  });

  it("rejects instead of hanging when the executable is not there", async () => {
    // Without the "error" event this would wait forever on a "close" that the
    // child never reaches.
    await expect(run("cmu-no-such-executable", [])).rejects.toThrow();
  });

  it("hands the child the environment it was given", async () => {
    await expect(
      run(
        process.execPath,
        ["-e", "process.exit(process.env.CMU_TEST_FLAG === 'on' ? 0 : 9)"],
        { env: { ...process.env, CMU_TEST_FLAG: "on" } },
      ),
    ).resolves.toBeUndefined();
  });

  it("runs the child in the directory it was given", async () => {
    const dir = realpathSync(tmpdir());
    await expect(
      run(
        process.execPath,
        [
          "-e",
          `process.exit(process.cwd() === ${JSON.stringify(dir)} ? 0 : 9)`,
        ],
        { cwd: dir },
      ),
    ).resolves.toBeUndefined();
  });
});
