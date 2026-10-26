// Plain copies of the Report types in `src/output/`, which commands may not import.

export type Tone = "ok" | "warn" | "error" | "muted";

/**
 * A path shows relative to the codebase or `~` in text modes, and with
 * `homeOnly` relative to `~` only; a code shows as a command.
 */
export type Text =
  | string
  | { path: string; homeOnly?: boolean }
  | { code: string };

/** A `table` cell. In text modes `true` shows as `✓` and `false` as `–`; JSON keeps the boolean. */
export type Cell = Text | boolean;

export type RepoStatus = "ok" | "skipped" | "failed" | "conflict";

/** One repo of a per-repo command. */
export interface RepoItem {
  repo: string;
  status: RepoStatus;
  message?: Text;
  hint?: Text;
  /** Where the branch of a new worktree came from: `local`, `tracking` or `new`. JSON only. */
  source?: string;
  /** `xr project remove --delete-branch` deleted the branch. JSON only. */
  branchDeleted?: boolean;
}

export interface FieldItem {
  key: string;
  value: Text | Text[];
  source?: Text;
  extra?: Record<string, Text>;
}

/** One project of a `projects` block. */
export interface ProjectItem {
  project: string;
  branch: string;
  path: Text;
  /** In record order. */
  repos: string[];
  created?: string;
}

/** One repo of a `project` block: `present` when its worktree folder exists. */
export interface ProjectRepoItem {
  repo: string;
  path: Text;
  present: boolean;
}

/** One repo of a `project-repos` block: `present` when its worktree folder exists. */
export interface ProjectRepoEntry extends ProjectRepoItem {
  /** From the merged config; `null` in JSON when absent. */
  description?: string;
}

/** What a part of the Report is, never how it looks (AD-3). */
export type Block =
  | { type: "value"; key: string; value: Text | boolean | number }
  | { type: "fields"; key: string; items: FieldItem[] }
  /** Rows of records. Each record has the same keys, which are the JSON field names. */
  | { type: "table"; key: string; items: Record<string, Cell>[] }
  | { type: "repos"; items: RepoItem[] }
  | { type: "checks"; items: { id: string; status: string; fix?: Text }[] }
  | {
      type: "leftovers";
      items: { what: string; path: Text; command: Text }[];
    }
  | { type: "section"; key: string; title: Text; blocks: Block[] }
  /** A list of parts prints them joined, on one line. */
  | { type: "note"; tone: Tone; text: Text | Text[] }
  | { type: "projects"; items: ProjectItem[] }
  | {
      type: "project";
      project: string;
      branch: string;
      path: Text;
      codebase: Text;
      created?: string;
      repos: ProjectRepoItem[];
    }
  | { type: "project-repos"; project: string; entries: ProjectRepoEntry[] };

export interface Report {
  blocks: Block[];
  error?: {
    code: string;
    message: string;
    hint?: string;
    details?: Record<string, unknown>;
    blocks?: Block[];
  };
}

export interface Warning {
  code: string;
  message: string;
  hint?: string;
}

export type LiveEvent =
  | { type: "step-start"; text: string }
  | { type: "step-end"; text: string; ok: boolean }
  | {
      type: "repo";
      repo: string;
      status: RepoStatus;
      message?: string;
      hint?: string;
    }
  | { type: "warning"; warning: Warning };
