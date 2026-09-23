import { execFileSync, spawnSync } from "child_process";
import { Command } from "commander";
import { fail } from "../utils/errors";
import { readPkg } from "../utils/pkg";

const PACKAGE_NAME = "cointmu-cli";

// Accepts semver versions, semver ranges, and npm dist-tags (e.g. "latest").
// Rejects anything carrying shell metacharacters ($()  ` ; | & ( ) etc.) or a
// leading "-" (npm argument injection). This is a defense-in-depth layer on top
// of the shell-free execFileSync calls below.
const VALID_TO = /^[0-9A-Za-z*~^><=][0-9A-Za-z .+~^><=*-]{0,99}$/;

interface UpdateOptions {
  to?: string;
  verbose?: boolean;
}

/**
 * Resolves a target version from the npm registry.
 * @param {string} [requested] - A specific semver/range to pin, or undefined for the latest release.
 * @returns {Promise<string>} The resolved version string published on the registry.
 * @throws {Error} If `requested` is not a valid version/range/dist-tag, or is not published.
 */
export async function resolveTargetVersion(
  requested?: string,
): Promise<string> {
  if (requested !== undefined && !VALID_TO.test(requested)) {
    throw new Error(
      `Invalid --to value "${requested}".\n` +
        `\x1b[2mhint:\x1b[0m ` +
        `expected a semver version, range, or npm dist-tag (e.g. "1.3.2", ">=1.3.0", "latest").`,
    );
  }

  const spec = requested ? `${PACKAGE_NAME}@${requested}` : PACKAGE_NAME;

  try {
    const raw = execFileSync("npm", ["view", spec, "version"], {
      stdio: "pipe",
    })
      .toString()
      .trim();

    // `npm view <pkg> version` prints the bare version for a single match, or
    // `<pkg>@x.y.z 'x.y.z'` lines when a range matches several. Take the last.
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      throw new Error("the npm registry returned no version");
    }

    const last = lines[lines.length - 1];
    const quoted = last.match(/'([^']+)'/);
    return quoted ? quoted[1] : last;
  } catch (error) {
    if (requested) {
      throw new Error(
        `Version "${requested}" is not available on the npm registry for ${PACKAGE_NAME}.\n` +
          `\x1b[2mhint:\x1b[0m list the published versions with \`npm view ${PACKAGE_NAME} versions\`.`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Turns a failed `npm install` stderr dump into an actionable message.
 * @param {string} stderr - Raw stderr captured from the npm child process.
 * @returns {string} A message explaining the failure and, where known, the fix.
 */
export function explainInstallFailure(stderr: string): string {
  if (stderr.includes("EALLOWGIT")) {
    return [
      "npm refused to install from a git source (EALLOWGIT).",
      "npm 12+ blocks git sources by default. This CLI installs from the npm",
      "registry, so an older CointMU build is most likely still running.",
      "Escape it once with:",
      `  npm install -g ${PACKAGE_NAME}@latest`,
    ].join("\n");
  }
  // A 404 on our own tarball URL means `npm view` already resolved the version
  // but the .tgz has not reached the CDN yet. Any other E404 stays generic.
  const tarball = stderr.match(/\/-\/cointmu-cli-([^/\s]+)\.tgz/);
  if (stderr.includes("E404") && tarball) {
    return [
      `version ${tarball[1]} resolves on the registry but its tarball has not finished propagating yet.`,
      `\x1b[2mhint:\x1b[0m wait a minute or two, then run \`cmu update\` again.`,
    ].join("\n");
  }
  return "npm install failed; see the npm output above.";
}

/**
 * Updates the CointMU CLI from the npm registry, optionally pinning a version.
 * @param {UpdateOptions} options - CLI options.
 * @returns {Promise<void>} Resolves when the update is complete.
 */
async function runUpdate(options: UpdateOptions = {}): Promise<void> {
  const current = readPkg().version;
  console.log("Checking the npm registry...");
  const target = await resolveTargetVersion(options.to);

  console.log(`current version : ${current}`);
  console.log(`target version  : ${target}`);

  if (current === target) {
    console.log("\nAlready on the target version. Nothing to do.");
    return;
  }

  const installArgs = ["install", "-g", `${PACKAGE_NAME}@${target}`];
  console.log(`\nRunning: npm ${installArgs.join(" ")}`);
  // ponytail: spawnSync (no shell) blocks command injection; win32 needs
  // "npm.cmd". If Node ever refuses .cmd via spawn, switch to a resolved
  // npm-cli.js path invoked through process.execPath.
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const install = spawnSync(
    npm,
    installArgs,
    // stderr is piped (not inherited) so EALLOWGIT can be recognised; it is
    // written straight back out below so npm's own output is never swallowed.
    { stdio: ["inherit", "inherit", "pipe"] },
  );

  const stderr = install.stderr?.toString() ?? "";
  if (stderr) {
    process.stderr.write(stderr);
  }
  if (install.error) {
    throw install.error;
  }
  if (install.status !== 0) {
    throw new Error(explainInstallFailure(stderr));
  }

  console.log(`\nUpdated ${PACKAGE_NAME} to ${target}.`);
}

export const updateCommand = new Command("update")
  .description("Update the CointMU CLI from the npm registry")
  .option(
    "--to <version>",
    "Install a specific published version instead of the latest",
  )
  .action((options, command) =>
    runUpdate(options).catch(fail("update", command.optsWithGlobals())),
  );
