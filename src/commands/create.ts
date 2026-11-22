import { existsSync } from "fs";
import * as path from "path";
import { Command } from "commander";
import { fail } from "../utils/errors";
import type { ConfigLocation } from "../utils/configGenerator";
import { pick, QUOTES } from "../utils/quotes";
import {
  generateProject,
  templateChoices,
  validTemplates,
} from "../utils/template";

interface CreateOptions {
  template?: string;
  language?: string;
  /** Write a cmu.config into the project instead of using the global one. */
  localConfig?: boolean;
  verbose?: boolean;
}

/** The network config question; global is listed first and is the default. */
const CONFIG_QUESTION = {
  type: "select",
  name: "configLocation",
  message: "Network config:",
  choices: [
    { name: "Global (~/.cmu-networks.json)", value: "global" },
    { name: "This project (cmu.config)", value: "project" },
  ],
  default: "global",
};

/**
 * Where the new project's networks come from: --local-config picks a project
 * cmu.config, a terminal is asked (undefined), and anything else - a script,
 * a CI job - gets the global default without a question it cannot answer.
 *
 * @param {CreateOptions} options - CLI options.
 * @returns {ConfigLocation | undefined} The location, or undefined to ask.
 */
function presetConfigLocation(
  options: CreateOptions,
): ConfigLocation | undefined {
  if (options.localConfig) return "project";
  return process.stdin.isTTY ? undefined : "global";
}

const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;

const ASCII_ART = `   ______      _       __  _____  __ 
  / ____/___  (_)___  / /_/ __  \\/ / /
 / /   / __ \\/ / __ \\/ __/ / / / / / /
/ /___/ /_/ / / / / / /_/ / / / / /_/ /
\\____/\\____/_/_/ /_/\\__/_/ /_/_/\\____/`;

/**
 * Prints the banner shown once a project has been scaffolded.
 *
 * The quote is passed in rather than drawn here so the output is a function of
 * its arguments.
 *
 * @param {string} projectName - The directory that was created.
 * @param {string} quote - Closing line to sign off with.
 * @returns {void}
 */
export function printWelcomeBanner(projectName: string, quote: string): void {
  console.log("");
  console.log(cyan(bold(ASCII_ART)));
  console.log("");
  console.log(
    `\x1b[32m${bold("Created")}\x1b[0m CointMU project '${cyan(projectName)}'\n`,
  );

  console.log(bold("Next steps:"));
  console.log(`  1. cd ${projectName}`);
  console.log(`  2. cmu compile`);
  console.log(`  3. cmu deploy\n`);

  console.log(`${cyan(quote)}\n`);
}

/**
 * Executes the project creation flow.
 * @param {string | undefined} project - The name of the project.
 * @param {CreateOptions} options - CLI options.
 * @returns {Promise<void>} Resolves when the project is fully initialized.
 */
export async function runCreate(
  project: string | undefined,
  options: CreateOptions,
): Promise<void> {
  const { default: inquirer } = await import("inquirer");

  let projectName = project?.trim() ?? "";

  if (!projectName) {
    const projectAnswer = await inquirer.prompt([
      {
        type: "input",
        name: "projectName",
        message: "Project name:",
        validate: (value: string) =>
          /^[a-zA-Z0-9_-]+$/.test(value.trim()) ||
          "project name may only contain letters, digits, hyphens and underscores.",
      },
    ]);

    projectName = projectAnswer.projectName.trim();
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(projectName)) {
    throw new Error(
      "project name may only contain letters, digits, hyphens and underscores.",
    );
  }

  const projectPath = path.resolve(process.cwd(), projectName);

  if (existsSync(projectPath)) {
    throw new Error(
      `directory '${projectName}' already exists.\n` +
        "\x1b[2mhint:\x1b[0m choose another name, or remove the existing directory first.",
    );
  }

  let template: string = options.template ?? "";
  let language: string = options.language ?? "";
  let configLocation = presetConfigLocation(options);

  const questions = [];

  if (!language) {
    questions.push({
      type: "select",
      name: "language",
      message: "Language:",
      choices: [
        { name: "TypeScript", value: "typescript" },
        { name: "JavaScript", value: "javascript" },
      ],
    });
  }

  if (!template) {
    questions.push({
      type: "select",
      name: "template",
      message: "Template:",
      choices: templateChoices,
    });
  }

  if (!configLocation) {
    questions.push(CONFIG_QUESTION);
  }

  if (questions.length > 0) {
    const answers = (await inquirer.prompt(questions)) as {
      language?: string;
      template?: string;
      configLocation?: ConfigLocation;
    };

    if (!language && answers.language) language = answers.language;
    if (!template && answers.template) template = answers.template;
    configLocation ??= answers.configLocation;
  }

  if (!validTemplates.includes(template)) {
    throw new Error(
      `unknown template '${template}'.\n` +
        `\x1b[2mhint:\x1b[0m ` +
        `choose one of: ${validTemplates.join(", ")}`,
    );
  }

  const validLanguages = ["typescript", "javascript"];

  if (!validLanguages.includes(language)) {
    throw new Error(
      `unknown language '${language}'.\n` +
        `\x1b[2mhint:\x1b[0m ` +
        `choose one of: ${validLanguages.join(", ")}`,
    );
  }

  await generateProject(projectPath, template, language, configLocation);

  printWelcomeBanner(projectName, pick(QUOTES));
}

export const createCommand = new Command("create")
  .description("Create a new CointMU workspace from a template")
  .argument("[project]", "Name of the project directory to create")
  .option(
    "-t, --template <template>",
    "Template to use (blank, erc20, erc721, erc1155, dao, marketplace, staking, airdrop, vault, kyberion)",
  )
  .option(
    "-l, --language <language>",
    "Language to use (typescript, javascript)",
  )
  .option(
    "--local-config",
    "Write a cmu.config into the project instead of using the global ~/.cmu-networks.json",
  )
  .action((project, options, command) =>
    runCreate(project, options).catch(
      fail("create", command.optsWithGlobals()),
    ),
  );
