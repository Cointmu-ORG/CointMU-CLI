import { describe, expect, it } from "vitest";
import { templates } from "../../src/templates";
import {
  blankDeployTemplate,
  getDeployScript,
  templateChoices,
  validTemplates,
} from "../../src/utils/template";

// generateProject() picks the contract straight out of this registry now, so a
// spec missing a field is a scaffold that writes a file called ".sol" rather
// than a type error.

describe("template registry", () => {
  it("accounts for every template the CLI accepts", () => {
    expect([...validTemplates].sort()).toEqual(Object.keys(templates).sort());
  });

  it("offers every template in the picker", () => {
    expect(templateChoices.map((choice) => choice.value)).toEqual(
      Object.keys(templates),
    );
    for (const choice of templateChoices) {
      expect(choice.name).toBeTruthy();
    }
  });

  it("lists blank first, so the picker opens on the empty project", () => {
    expect(templateChoices[0].value).toBe("blank");
  });

  it("gives blank no contract to write", () => {
    expect(templates.blank.source).toBeUndefined();
    expect(templates.blank.contract).toBeUndefined();
  });

  it.each(Object.entries(templates).filter(([, spec]) => spec.source))(
    "carries real Solidity for %s",
    (_name, spec) => {
      expect(spec.source).toContain("SPDX-License-Identifier");
      expect(spec.source).toContain(`contract ${spec.contract}`);
    },
  );

  it.each(Object.entries(templates).filter(([, spec]) => spec.contract))(
    "names %s with a contract the deploy script can resolve",
    (_name, spec) => {
      // generateProject writes deploy/01_<lowercased>.ts and the script looks
      // the artifact up by the contract name, so it has to be a bare identifier.
      expect(spec.contract).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      expect(spec.deployArgs).toBeTypeOf("string");
    },
  );
});

// The generated deploy scripts are run by `cmu deploy` as standalone programs
// (`node deploy/01_x.js`), never require()d, so anything they hide behind an
// export never executes and anything they expect as a parameter never arrives.
// These assertions pin the shape that survives that: top-level, env-fed, and
// loud when it fails.
describe("generated deploy scripts", () => {
  const contractTemplates = Object.entries(templates).filter(
    ([, spec]) => spec.contract,
  );

  const scripts = [
    ...contractTemplates.flatMap(([name, spec]) =>
      (["javascript", "typescript"] as const).map((language) => ({
        id: `${name} (${language})`,
        contract: spec.contract!,
        source: getDeployScript(
          spec.contract!,
          spec.deployArgs ?? "",
          language,
        ),
      })),
    ),
    ...(["javascript", "typescript"] as const).map((language) => ({
      id: `blank (${language})`,
      contract: undefined,
      source: blankDeployTemplate(language),
    })),
  ];

  it.each(scripts)("$id runs at top level", ({ source }) => {
    expect(source).not.toContain("module.exports");
    expect(source).not.toContain("export default");
    expect(source).toMatch(/^main\(\)/m);
  });

  it.each(scripts)("$id fails loudly", ({ source }) => {
    // console.error alone leaves the exit code at 0, and `cmu deploy` then
    // reports a deploy that never happened as a success.
    expect(source).toContain("process.exitCode = 1");
  });

  it.each(scripts.filter((s) => s.contract))(
    "$id takes its key and RPC from the environment",
    ({ source }) => {
      expect(source).toContain("process.env.PRIVATE_KEY");
      expect(source).toContain("process.env.CMU_RPC_URL");
    },
  );

  it.each(scripts.filter((s) => s.contract))(
    "$id reads the flat artifact cmu compile writes",
    ({ source, contract }) => {
      // compile.ts writes artifacts/<Contract>.json, not the nested
      // artifacts/contracts/<File>.sol/<Contract>.json Hardhat produces.
      expect(source).toContain(`'../artifacts/${contract}.json'`);
      expect(source).toContain("artifact.evm?.bytecode?.object");
    },
  );

  it.each(scripts.filter((s) => s.contract))(
    "$id prints the deployed address",
    ({ source, contract }) => {
      expect(source).toContain("await contract.getAddress()");
      expect(source).toContain(
        `console.log(\`${contract} deployed at \${address}\`)`,
      );
    },
  );
});
