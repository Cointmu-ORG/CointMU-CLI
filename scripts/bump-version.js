/**
 * Bumps the package.json version, rebuilds, commits, tags, and pushes.
 * @example
 * node scripts/bump-version.js patch my-codename
 * node scripts/bump-version.js minor my-codename beta.1
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const PACKAGE_JSON_PATH = path.resolve(__dirname, "../package.json");
const ENCODING_UTF8 = "utf8";

const ARG_POSITION_BUMP_TYPE = 2;
const ARG_POSITION_CODENAME = 3;
const ARG_POSITION_PRERELEASE = 4;
const VERSION_PARTS_LENGTH = 3;
const PART_MAJOR_INDEX = 0;
const PART_MINOR_INDEX = 1;
const PART_PATCH_INDEX = 2;
const INDENT_SPACES = 2;

const EXIT_CODE_ERROR = 1;

/**
 * Reads and parses the package.json file.
 * @returns {Object} The parsed package.json object.
 */
function readPackageJson() {
  const content = fs.readFileSync(PACKAGE_JSON_PATH, ENCODING_UTF8);
  return JSON.parse(content);
}

/**
 * Writes the updated package.json object back to the file.
 * @param {Object} pkg - The package.json object to write.
 * @returns {void}
 */
function writePackageJson(pkg) {
  const content = JSON.stringify(pkg, null, INDENT_SPACES) + "\n";
  fs.writeFileSync(PACKAGE_JSON_PATH, content, ENCODING_UTF8);
}

/**
 * Bumps the version string based on the given bump type and optional prerelease tag.
 * @param {string} currentVersion - The current version string.
 * @param {string} bumpType - The type of bump (major, minor, patch).
 * @param {string} [prereleaseTag] - An optional prerelease tag.
 * @returns {string} The new version string.
 */
function calculateNewVersion(currentVersion, bumpType, prereleaseTag) {
  const versionCore = currentVersion.split("-")[0];
  const parts = versionCore.split(".").map(Number);

  if (parts.length !== VERSION_PARTS_LENGTH) {
    throw new Error("Invalid version format in package.json");
  }

  let major = parts[PART_MAJOR_INDEX];
  let minor = parts[PART_MINOR_INDEX];
  let patch = parts[PART_PATCH_INDEX];

  if (bumpType === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bumpType === "minor") {
    minor += 1;
    patch = 0;
  } else if (bumpType === "patch") {
    patch += 1;
  } else {
    throw new Error("Invalid bump type. Use major, minor, or patch.");
  }

  let newVersion = `${major}.${minor}.${patch}`;

  if (prereleaseTag) {
    newVersion += `-${prereleaseTag}`;
  }

  return newVersion;
}

/**
 * Executes a shell command synchronously and logs the output.
 * @param {string} command - The shell command to execute.
 * @returns {void}
 */
function runCommand(command) {
  console.log(`Executing: ${command}`);
  execSync(command, { stdio: "inherit", cwd: path.resolve(__dirname, "..") });
}

/**
 * Checks whether a git tag already exists locally.
 * @param {string} tag - The tag name to look for.
 * @returns {boolean} True if the tag exists.
 */
function tagExists(tag) {
  const out = execSync(`git tag --list ${tag}`, {
    encoding: ENCODING_UTF8,
    cwd: path.resolve(__dirname, ".."),
  });
  return out.trim() !== "";
}

/**
 * Main execution flow for the bump version script.
 * @returns {void}
 */
function main() {
  const args = process.argv;
  const bumpType = args[ARG_POSITION_BUMP_TYPE];
  const newCodename = args[ARG_POSITION_CODENAME];
  const prereleaseTag = args[ARG_POSITION_PRERELEASE];

  if (!bumpType || !newCodename) {
    console.error(
      "Usage: node scripts/bump-version.js <major|minor|patch> <codename> [prerelease-tag]",
    );
    process.exit(EXIT_CODE_ERROR);
  }

  const pkg = readPackageJson();
  const previousVersion = pkg.version;
  const previousCodename = pkg.codename;
  const newVersion = calculateNewVersion(
    previousVersion,
    bumpType,
    prereleaseTag,
  );

  if (tagExists(`v${newVersion}`)) {
    console.error(
      `Version update aborted: tag v${newVersion} already exists.\n` +
        `Delete it (git tag -d v${newVersion}) or pick a different bump type.`,
    );
    process.exit(EXIT_CODE_ERROR);
  }

  try {
    console.log("Running build process to verify before version bump...");
    execSync("npm run build", { stdio: "inherit" });
  } catch {
    console.error("Version update aborted: Build process failed with errors.");
    process.exit(EXIT_CODE_ERROR);
  }

  console.log(
    `Bumping version from ${previousVersion} to ${newVersion} with codename ${newCodename}`,
  );

  pkg.version = newVersion;
  pkg.codename = newCodename;
  writePackageJson(pkg);

  try {
    console.log("Rebuilding to verify the bumped package.json...");
    execSync("npm run build", { stdio: "inherit" });
  } catch {
    console.error(
      "Version update aborted: post-bump build failed. Reverting package.json.",
    );
    pkg.version = previousVersion;
    pkg.codename = previousCodename;
    writePackageJson(pkg);
    process.exit(EXIT_CODE_ERROR);
  }

  runCommand("npm install");
  runCommand("git add .");
  const fullVersionString = `${newVersion}-${newCodename}`;
  runCommand(`git commit -m "chore: release version ${fullVersionString}"`);
  runCommand(`git tag -a v${newVersion} -m "Release v${newVersion}"`);
  runCommand("git push origin main");
  runCommand("git push origin --tags");

  console.log(`Successfully released version ${fullVersionString}`);
}

main();
