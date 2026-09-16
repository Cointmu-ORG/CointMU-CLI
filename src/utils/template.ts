import { generateConfigFiles } from "./configGenerator";
import { aliases, templates } from "../templates";

const TYPESCRIPT_LANG = "typescript";
const ENCODING = "utf8";
const FS_EXTRA_PKG = "fs-extra";
const PATH_PKG = "path";
const CHILD_PROCESS_PKG = "child_process";

export const templateChoices = Object.entries(templates).map(
  ([value, spec]) => ({ name: spec.label, value }),
);

export const validTemplates = [
  ...Object.keys(templates),
  ...Object.keys(aliases),
];

function getDeployScript(
  contractName: string,
  contractArgs: string,
  language: string,
): string {
  const tsImports = `import { ethers } from 'ethers';
import fs from 'fs-extra';
import path from 'path';`;

  const jsImports = `const { ethers } = require('ethers');
const fs = require('fs-extra');
const path = require('path');`;

  return `${language === TYPESCRIPT_LANG ? tsImports : jsImports}

async function main() {
  console.log('Deploying ${contractName}...');
  
  const artifactPath = path.resolve(__dirname, '../artifacts/${contractName}.json');
  if (!fs.existsSync(artifactPath)) {
    throw new Error('Artifact not found. Run \`cmu compile\` first.');
  }

  const artifact = await fs.readJson(artifactPath);
  const abi = artifact.abi;
  const bytecode = artifact.evm?.bytecode?.object || artifact.bytecode;

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error('PRIVATE_KEY is not set in the environment.');
  
  const provider = new ethers.JsonRpcProvider(process.env.CMU_RPC_URL || 'http://localhost:8545');
  const wallet = new ethers.Wallet(privateKey, provider);

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy(${contractArgs});
  await contract.waitForDeployment();
  
  const address = await contract.getAddress();
  console.log(\`${contractName} deployed at \${address}\`);

  // Save artifact
  const deploymentDir = path.resolve(__dirname, '../deployments');
  await fs.ensureDir(deploymentDir);
  const deploymentPath = path.join(deploymentDir, '${contractName}.json');
  
  await fs.writeJson(deploymentPath, {
    address,
    abi,
    network: await provider.getNetwork().then(n => ({ chainId: Number(n.chainId), name: n.name }))
  }, { spaces: 2 });
  console.log(\`Deployment saved to \${deploymentPath}\`);
}

main().catch(console.error);
`;
}

const blankDeployTemplate = (language: string): string => {
  const ethersImport =
    language === TYPESCRIPT_LANG
      ? "import { ethers } from 'ethers';"
      : "const { ethers } = require('ethers');";

  return `${ethersImport}

async function main() {
  console.log('Deploy script executed.');
  // Add your deployment logic here, e.g.
  // const provider = new ethers.JsonRpcProvider(process.env.CMU_RPC_URL);
}

main().catch(console.error);
`;
};

export async function generateProject(
  projectPath: string,
  template: string,
  language: string,
): Promise<void> {
  const fs =
    (await import(FS_EXTRA_PKG)).default || (await import(FS_EXTRA_PKG));
  const path = await import(PATH_PKG);
  const { execSync } = await import(CHILD_PROCESS_PKG);

  const dirs = [
    "contracts",
    "scripts",
    "artifacts",
    "deployments",
    "deploy",
    "test",
  ];
  for (const dir of dirs) {
    await fs.ensureDir(path.join(projectPath, dir));
  }

  const ext = language === TYPESCRIPT_LANG ? "ts" : "js";

  const templateTestContent = `import { expect } from "chai";
import { ethers } from "ethers";

describe("Deployment Template Test", function () {
  it("Should connect to the local ephemeral node successfully", async function () {
    const provider = new ethers.JsonRpcProvider(process.env.CMU_RPC_URL || "http://127.0.0.1:8555");
    const network = await provider.getNetwork();
    
    expect(Number(network.chainId)).to.be.greaterThan(0);
  });
});
`;

  await fs.writeFile(
    path.join(projectPath, "test", `Template.test.${ext}`),
    templateTestContent,
    ENCODING,
  );

  await generateConfigFiles(projectPath, language);

  await fs.writeFile(
    path.join(projectPath, "artifacts", ".gitkeep"),
    "",
    ENCODING,
  );
  await fs.writeFile(
    path.join(projectPath, "deployments", ".gitkeep"),
    "",
    ENCODING,
  );
  await fs.writeFile(
    path.join(projectPath, "scripts", ".gitkeep"),
    "",
    ENCODING,
  );

  if (language === TYPESCRIPT_LANG) {
    const tsconfig = {
      compilerOptions: {
        target: "ES2022",
        module: "CommonJS",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
      },
      include: ["scripts/**/*", "deploy/**/*"],
    };
    await fs.writeJson(path.join(projectPath, "tsconfig.json"), tsconfig, {
      spaces: 2,
    });
  }

  const spec = templates[aliases[template] ?? template];

  if (!spec?.load) {
    // "blank", and anything else with no contract behind it.
    await fs.writeFile(
      path.join(projectPath, "contracts", ".gitkeep"),
      "",
      ENCODING,
    );
    await fs.writeFile(
      path.join(projectPath, "deploy", `01_deploy.${ext}`),
      blankDeployTemplate(language),
      ENCODING,
    );
  } else {
    const contractName = spec.contract!;
    await fs.writeFile(
      path.join(projectPath, "contracts", `${contractName}.sol`),
      await spec.load(),
      ENCODING,
    );
    await fs.writeFile(
      path.join(
        projectPath,
        "deploy",
        `01_${contractName.toLowerCase()}.${ext}`,
      ),
      getDeployScript(contractName, spec.deployArgs ?? "", language),
      ENCODING,
    );
  }

  const projectName = path.basename(projectPath);
  const packageJson = {
    name: projectName,
    version: "1.0.0",
    description: `CointMU ${template} project`,
    scripts: {
      test: "cmu test",
    },
    dependencies: {},
  };

  await fs.writeJson(path.join(projectPath, "package.json"), packageJson, {
    spaces: 2,
  });

  console.log("Installing dependencies...");
  execSync("npm install ethers", {
    cwd: projectPath,
    stdio: "inherit",
  });

  if (language === TYPESCRIPT_LANG) {
    console.log("Installing dev dependencies...");
    execSync(
      "npm install --save-dev @types/node mocha chai @types/mocha @types/chai ts-node typescript@5",
      {
        cwd: projectPath,
        stdio: "inherit",
      },
    );
  } else {
    console.log("Installing dev dependencies...");
    execSync("npm install --save-dev mocha chai", {
      cwd: projectPath,
      stdio: "inherit",
    });
  }
}
