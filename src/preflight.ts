export const MIN_NODE_MAJOR = 20;

/**
 * Checks whether a Node.js version string meets the minimum this CLI supports.
 * @param {string} version A Node version string such as `process.version` ("v20.11.1").
 * @returns {string | null} An error message when the version is too old, otherwise null.
 */
export function checkNodeVersion(version: string): string | null {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  // Unparseable version: assume it is fine rather than block a working runtime.
  if (Number.isNaN(major) || major >= MIN_NODE_MAJOR) return null;
  return `cmu-cli butuh Node.js ${MIN_NODE_MAJOR} atau lebih baru, kamu pakai Node ${version}. Upgrade dulu ya.`;
}

const problem = checkNodeVersion(process.version);
if (problem) {
  console.error(problem);
  process.exit(1);
}
