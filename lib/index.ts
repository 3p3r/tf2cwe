import path from "path";
import Parser from "web-tree-sitter";
import { walk } from "./input";
import * as terraform from "./terraform";
export * as ast from "./ast";

const LANGUAGE_WASM = path.resolve(__dirname, "..", "tree-sitter-hcl.wasm");

export enum Language {
  Terraform = "hcl",
}

interface CompileOptions {
  input: string;
  language: Language;
}

const WALK_OPTIONS = {
  [Language.Terraform]: {
    depth: 0,
    extensions: [".tf", ".tfvars"],
  },
};

const createParser = async (): Promise<Parser> => {
  await Parser.init();
  const parser = new Parser();
  const language = await Parser.Language.load(LANGUAGE_WASM);
  parser.setLanguage(language);
  return parser;
};

export async function compile(options: CompileOptions) {
  if (!options.input) {
    throw new Error("tf2cwe compile requires an input");
  }

  const parser = await createParser();
  const sources = await walk(options.input, WALK_OPTIONS[options.language]);

  switch (options.language) {
    case Language.Terraform:
      return await terraform.compile(parser, sources);
    default:
      break;
  }
}
