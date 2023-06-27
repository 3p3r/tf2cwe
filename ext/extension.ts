import assert from "assert";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import * as childProcess from "child_process";
import { input, output } from "../lib";
import { contributes } from "./package.json";

const { compile } = require("tree-sitter-eventrule/dist/main") as { compile: (rulePath: string) => Promise<string[]> };
assert(typeof compile === "function");

const VALIDATE_COMMAND = Object.values(contributes.commands)?.[0].command;
assert(VALIDATE_COMMAND);

const INLINE_POLICY_SETTING = Object.keys(contributes.configuration.properties)[0];
assert(INLINE_POLICY_SETTING);

const PATH_POLICY_SETTING = Object.keys(contributes.configuration.properties)[1];
assert(PATH_POLICY_SETTING);

class Rand {
  private static pool = new Set<number>();
  static unique(): number {
    while (true) {
      const r = Math.random() * Date.now();
      if (!Rand.pool.has(r)) {
        Rand.pool.add(r);
        return r;
      }
    }
  }
}

async function compileInlinePolicyToRego(): Promise<string> {
  const policySetting = vscode.workspace.getConfiguration().get(INLINE_POLICY_SETTING);
  const policyJson = JSON.parse(policySetting as string);
  const policyPath = path.join(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), "tf2cwe2rego-")),
    `policy${Rand.unique()}.json`,
  );
  await fs.promises.writeFile(policyPath, JSON.stringify(policyJson));
  const rego = await compile(policyPath);
  await fs.promises.rm(path.dirname(policyPath), { recursive: true, force: true });
  return rego[0];
}

async function compilePathPolicyToRego(): Promise<string[]> {
  const policySetting = vscode.workspace.getConfiguration().get(PATH_POLICY_SETTING);
  const policyPath = policySetting as string;
  if (!policyPath) {
    return [];
  }
  const rego = await compile(policyPath);
  return rego;
}

async function compilePolicyToRego(): Promise<string[]> {
  const ret = new Array<string>();
  try {
    ret.push(await compileInlinePolicyToRego());
  } catch (e) {
    console.error(`failed to compile inline policy: ${e.message}`);
  }
  try {
    ret.push(...(await compilePathPolicyToRego()));
  } catch (e) {
    console.error(`failed to compile path policy: ${e.message}`);
  }
  return ret;
}

async function compileTerraformToCWE(terraformPath: string, shell = true): Promise<string[]> {
  try {
    // todo: remove this path after lib is updated
    if (shell) {
      const out = childProcess.execSync(`npm run --silent bin -- ${terraformPath}`, { cwd: "/home/sep/tf2cwe" });
      const events = JSON.parse(out.toString()) as any[];
      return events.map((e: any) => JSON.stringify(e)).filter(Boolean);
    }
    const nodes = await input.compile({ input: terraformPath, language: input.Language.Terraform });
    const out = await output.compile({ input: nodes, language: output.Language.CloudTrail });
    return out.map((e) => JSON.stringify(e)).filter(Boolean);
  } catch (e) {
    console.error(`failed to compile terraform to CWE: ${e.message}`);
    return [];
  }
}

async function validate(rules: string[], events: string[]): Promise<boolean> {
  let validated = true;
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tf2cwe2rego-"));
  for (const rule of rules) {
    const rulePath = path.join(tmpDir, `rule${Rand.unique()}.rego`);
    await fs.promises.writeFile(rulePath, rule);
    for (const event of events) {
      const eventPath = path.join(tmpDir, `event${Rand.unique()}.json`);
      await fs.promises.writeFile(eventPath, event);
      const result = await new Promise<string>((resolve, reject) => {
        const cmd = `opa eval --format json --input ${eventPath} --data ${rulePath} "data.rule2rego.allow"`;
        childProcess.exec(cmd, (err, stdout, stderr) => {
          if (err) {
            reject(err);
            return;
          }
          if (stderr) {
            reject(stderr);
            return;
          }
          if (stdout) {
            resolve(stdout);
            return;
          }
          reject(new Error("no output"));
        });
      });
      const resultJson = JSON.parse(result);
      const value = resultJson?.result?.[0]?.expressions?.[0]?.value;
      validated = validated && value;
    }
    await fs.promises.rm(rulePath);
  }
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
  return validated;
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(VALIDATE_COMMAND, async (resource) => {
      const terraformPath = resource?.fsPath;
      if (!terraformPath) {
        vscode.window.showWarningMessage("no path selected for validation");
        return;
      }
      vscode.window.showInformationMessage(`validating ${terraformPath}`);
      const rules = await compilePolicyToRego();
      const events = await compileTerraformToCWE(terraformPath);
      const valid = await validate(rules, events);
      if (valid) {
        vscode.window.showInformationMessage("terraform is valid against policies");
      } else {
        vscode.window.showErrorMessage("terraform is invalid against policies");
      }
    }),
  );
}
