/** The characters a branch may not have, on every OS, because they are not valid in a Windows folder name. */
const BAD_BRANCH_CHARS = ["<", ">", ":", "|", '"', "?", "*"] as const;

/** The most characters of a hook step line. */
const LABEL_WIDTH = 60;

/** The project folder name of a branch: each `/` becomes `--`. */
export function branchSlug(branch: string): string {
  return branch.replaceAll("/", "--");
}

/** Each of `<>:|"?*` in `branch`, once, in the order they first appear. */
export function badBranchChars(branch: string): string[] {
  return [...new Set(branch)].filter((char) =>
    (BAD_BRANCH_CHARS as readonly string[]).includes(char),
  );
}

/**
 * The env of a hook line: `inherited`, then `vars`, then `builtIns`, where a
 * later name wins. On `win32` names match with case ignored, and the later
 * spelling stays.
 */
export function hookEnv(
  inherited: Readonly<Record<string, string | undefined>>,
  vars: Readonly<Record<string, string>>,
  builtIns: Readonly<Record<string, string>>,
  platform: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  const set = (name: string, value: string) => {
    if (platform === "win32") {
      const lower = name.toLowerCase();
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === lower) delete env[key];
      }
    }
    env[name] = value;
  };
  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined) set(name, value);
  }
  for (const [name, value] of Object.entries(vars)) set(name, value);
  for (const [name, value] of Object.entries(builtIns)) set(name, value);
  return env;
}

/** What the built-in `CROSSREPO_*` vars of a hook are made from. */
export interface HookVarsInput {
  codebasePath: string;
  codebaseName: string;
  projectPath: string;
  projectName: string;
  branch: string;
  /** In record order. */
  repos: readonly string[];
  hook: "post-create" | "pre-remove";
}

/** The 7 built-in vars of a hook line. */
export function hookVars(input: HookVarsInput): Record<string, string> {
  return {
    CROSSREPO_CODEBASE_PATH: input.codebasePath,
    CROSSREPO_CODEBASE_NAME: input.codebaseName,
    CROSSREPO_PROJECT_PATH: input.projectPath,
    CROSSREPO_PROJECT_NAME: input.projectName,
    CROSSREPO_PROJECT_BRANCH: input.branch,
    CROSSREPO_PROJECT_REPOS: input.repos.join("\n"),
    CROSSREPO_HOOK: input.hook,
  };
}

/** `<hook>: <command>` on one line of at most 60 characters; a cut label ends with `…`. */
export function hookStepLabel(hook: string, command: string): string {
  const [first = ""] = command.split(/\r?\n/);
  const full = `${hook}: ${first}`;
  const cut = first !== command.replace(/\r?\n$/, "");
  if (!cut && full.length <= LABEL_WIDTH) return full;
  return `${full.slice(0, LABEL_WIDTH - 1)}…`;
}

/** The last `count` lines of `text`, joined with `\n`, without a final empty line. */
export function lastLines(text: string, count: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-count).join("\n");
}

/** ISO 8601 UTC to the second with `Z`, such as `2026-10-20T14:03:12Z`. */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
