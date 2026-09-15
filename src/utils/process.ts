const LISTENING_STATE = "LISTENING";
const CHILD_PROCESS_PKG = "child_process";
const UTIL_PKG = "util";
const NETSTAT_CMD = "netstat -ano | findstr :";
const TASKKILL_CMD = "taskkill /F /PID ";

/**
 * Checks if a specific port is occupied and forcefully terminates the process occupying it.
 * Designed for Windows environments using netstat and taskkill.
 *
 * @param {number} port - The port number to check and free.
 * @returns {Promise<void>} Resolves when the operation is complete.
 */
export async function killPort(port: number): Promise<void> {
  try {
    const { exec } = await import(CHILD_PROCESS_PKG);
    const { promisify } = await import(UTIL_PKG);
    const execAsync = promisify(exec);

    const { stdout } = await execAsync(`${NETSTAT_CMD}${port}`);

    if (!stdout) {
      console.log(`Port ${port} is free.`);
      return;
    }

    const lines = stdout.split("\n");
    let processKilled = false;

    for (const line of lines) {
      if (line.includes(`:${port}`) && line.includes(LISTENING_STATE)) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];

        if (pid) {
          console.log(`Port ${port} is in use by PID ${pid}; stopping it...`);
          try {
            await execAsync(`${TASKKILL_CMD}${pid}`);
            processKilled = true;
          } catch {
            console.warn(
              `\x1b[33mwarning:\x1b[0m could not free port ${port}; PID ${pid} is still listening.`,
            );
          }
        }
      }
    }

    if (!processKilled) {
      console.log(`Port ${port} is free.`);
    }
  } catch {
    // If findstr finds no matches, it exits with an error code, which is caught here.
    console.log(`Port ${port} is free.`);
  }
}
