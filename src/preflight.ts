export const MIN_NODE_MAJOR = 20;
/** process.loadEnvFile(), which replaced dotenv, landed in Node 20.12.0. */
export const MIN_NODE_MINOR = 12;

/**
 * Checks whether a Node.js version string meets the minimum this CLI supports.
 * @param {string} version A Node version string such as `process.version` ("v20.11.1").
 * @returns {string | null} An error message when the version is too old, otherwise null.
 */
export function checkNodeVersion(version: string): string | null {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);

  // Every comparison with NaN or a missing minor is false, so an unparseable
  // version, or a bare major ("v20") with no minor to judge, passes rather than
  // blocking a working runtime.
  const tooOld =
    major < MIN_NODE_MAJOR ||
    (major === MIN_NODE_MAJOR && minor < MIN_NODE_MINOR);
  if (!tooOld) return null;

  return (
    `\x1b[31merror:\x1b[0m cmu requires Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer, but this is Node ${version}.\n` +
    "\x1b[2mhint:\x1b[0m upgrade Node.js, or install a version manager such as nvm or fnm."
  );
}

const problem = checkNodeVersion(process.version);
if (problem) {
  console.error(problem);
  process.exit(1);
}
