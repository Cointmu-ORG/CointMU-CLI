import { mkdir, writeFile } from "fs/promises";
import { generateConfigFiles } from "./configGenerator";
import { templates } from "../templates";

const TYPESCRIPT_LANG = "typescript";
const ENCODING = "utf8";
const PATH_PKG = "path";
const CHILD_PROCESS_PKG = "child_process";

export const templateChoices = Object.entries(templates).map(
  ([value, spec]) => ({ name: spec.label, value }),
);

export const validTemplates = Object.keys(templates);

function getDeployScript(
  contractName: string,
  contractArgs: string,
  language: string,
): string {
  const tsImports = `import { ethers } from 'ethers';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';`;

  const jsImports = `const { ethers } = require('ethers');
const { existsSync } = require('fs');
const { mkdir, readFile, writeFile } = require('fs/promises');
const path = require('path');`;

  return `${language === TYPESCRIPT_LANG ? tsImports : jsImports}

async function main() {
  console.log('Deploying ${contractName}...');
  
  const artifactPath = path.resolve(__dirname, '../artifacts/${contractName}.json');
  if (!existsSync(artifactPath)) {
    throw new Error('Artifact not found. Run \`cmu compile\` first.');
  }

  const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
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
  await mkdir(deploymentDir, { recursive: true });
  const deploymentPath = path.join(deploymentDir, '${contractName}.json');
  
  await writeFile(deploymentPath, JSON.stringify({
    address,
    abi,
    network: await provider.getNetwork().then(n => ({ chainId: Number(n.chainId), name: n.name }))
  }, null, 2) + '\\n');
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
    await mkdir(path.join(projectPath, dir), { recursive: true });
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

  await writeFile(
    path.join(projectPath, "test", `Template.test.${ext}`),
    templateTestContent,
    ENCODING,
  );

  await generateConfigFiles(projectPath, language);

  await writeFile(
    path.join(projectPath, "artifacts", ".gitkeep"),
    "",
    ENCODING,
  );
  await writeFile(
    path.join(projectPath, "deployments", ".gitkeep"),
    "",
    ENCODING,
  );
  await writeFile(path.join(projectPath, "scripts", ".gitkeep"), "", ENCODING);

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
    await writeFile(
      path.join(projectPath, "tsconfig.json"),
      `${JSON.stringify(tsconfig, null, 2)}\n`,
    );
  }

  const spec = templates[template];

  if (!spec?.load) {
    // "blank", and anything else with no contract behind it.
    await writeFile(
      path.join(projectPath, "contracts", ".gitkeep"),
      "",
      ENCODING,
    );
    await writeFile(
      path.join(projectPath, "deploy", `01_deploy.${ext}`),
      blankDeployTemplate(language),
      ENCODING,
    );
  } else {
    const contractName = spec.contract!;
    await writeFile(
      path.join(projectPath, "contracts", `${contractName}.sol`),
      await spec.load(),
      ENCODING,
    );
    await writeFile(
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

  await writeFile(
    path.join(projectPath, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );

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
