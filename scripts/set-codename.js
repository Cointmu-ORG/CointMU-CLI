/**
 * Writes the codename from CMU_CODENAME into package.json.
 *
 * Runs as npm's `version` lifecycle hook, which fires after npm has written the
 * new version and before it stages package.json — so the codename lands in the
 * release commit without a second commit or an amend.
 */
const fs = require("fs");
const path = require("path");

const codename = process.env.CMU_CODENAME;

if (!codename) {
  console.error("set-codename: CMU_CODENAME is not set");
  process.exit(1);
}

const file = path.resolve(__dirname, "../package.json");
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));

pkg.codename = codename;
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n", "utf8");
