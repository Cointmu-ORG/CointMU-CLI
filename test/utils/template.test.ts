import { describe, expect, it } from "vitest";
import { aliases, templates } from "../../src/templates";
import { templateChoices, validTemplates } from "../../src/utils/template";

// generateProject() picks the contract straight out of this registry now, so a
// spec missing a field is a scaffold that writes a file called ".sol" rather
// than a type error.

describe("template registry", () => {
  it("accounts for every template the CLI accepts", () => {
    expect([...validTemplates].sort()).toEqual(
      [...Object.keys(templates), ...Object.keys(aliases)].sort(),
    );
  });

  it("offers every template except the aliases in the picker", () => {
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

  it("resolves every alias to a template that exists", () => {
    for (const [alias, target] of Object.entries(aliases)) {
      expect(templates[target], `${alias} -> ${target}`).toBeDefined();
    }
    expect(templates[aliases.nft].contract).toBe("StandardERC721");
  });

  it("gives blank no contract to write", () => {
    expect(templates.blank.load).toBeUndefined();
    expect(templates.blank.contract).toBeUndefined();
  });

  it.each(
    Object.entries(templates).filter(([, spec]) => spec.load !== undefined),
  )("loads real Solidity for %s", async (_name, spec) => {
    const source = await spec.load!();

    expect(source).toContain("SPDX-License-Identifier");
    expect(source).toContain(`contract ${spec.contract}`);
  });

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
