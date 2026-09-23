import { describe, expect, it } from "vitest";
import { realpathSync } from "fs";
import { tmpdir } from "os";
import { run } from "../../src/utils/exec";

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
