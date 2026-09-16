const LISTENING_STATE = "LISTENING";
const NETSTAT_CMD = "netstat";
const NETSTAT_ARGS = ["-ano"];
const TASKKILL_CMD = "taskkill";
const TASKKILL_ARGS = ["/F", "/PID"];
const PID_PATTERN = /^\d+$/;

/**
 * Checks if a specific port is occupied and forcefully terminates the process occupying it.
 * Designed for Windows environments using netstat and taskkill.
 *
 * Both commands are invoked with an argument array and no shell, and the PID is
 * parsed out of netstat's output, so it is validated as purely numeric before it
 * reaches taskkill.
 *
 * @param {number} port - The port number to check and free.
 * @returns {Promise<void>} Resolves when the operation is complete.
 * @throws {Error} If netstat reports a PID that is not purely numeric.
 */
export async function killPort(port: number): Promise<void> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  let stdout = "";
  try {
    ({ stdout } = await execFileAsync(NETSTAT_CMD, NETSTAT_ARGS));
  } catch {
    // netstat is unavailable (non-Windows) or exited non-zero: nothing to free.
    console.log(`Port ${port} is free.`);
    return;
  }

  let processKilled = false;

  for (const line of stdout.split("\n")) {
    if (!line.includes(`:${port}`) || !line.includes(LISTENING_STATE)) {
      continue;
    }

    const parts = line.trim().split(/\s+/);
    const pid = parts[parts.length - 1];

    if (!pid) {
      continue;
    }

    if (!PID_PATTERN.test(pid)) {
      throw new Error(
        `netstat reported a non-numeric PID '${pid}' for port ${port}.\n` +
          "\x1b[2mhint:\x1b[0m free the port manually, then run the command again.",
      );
    }

    console.log(`Port ${port} is in use by PID ${pid}; stopping it...`);
    try {
      await execFileAsync(TASKKILL_CMD, [...TASKKILL_ARGS, pid]);
      processKilled = true;
    } catch {
      console.warn(
        `\x1b[33mwarning:\x1b[0m could not free port ${port}; PID ${pid} is still listening.`,
      );
    }
  }

  if (!processKilled) {
    console.log(`Port ${port} is free.`);
  }
}
