import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { keyName, scalar } from "./codebase-config.ts";

/** A `.crossrepo/project.yaml` as the reader gives it. */
export interface ProjectRecord {
  /** Absent only in an old record read with `requireBranch: false`. */
  branch?: string;
  /** As written: absolute, or relative to the project folder. */
  codebase: string;
  /** The repo names of the project. */
  repos: string[];
  /** ISO 8601 UTC, when the record has it. */
  created?: string;
}

/** What `renderProjectRecord` writes. */
export interface NewProjectRecord {
  branch: string;
  /** Absolute, in native OS form. */
  codebase: string;
  /** In codebase config order, as written; at least one. */
  repos: readonly string[];
  /** ISO 8601 UTC to the second with `Z`. */
  created: string;
}

export interface ParseRecordOptions {
  /** A record with no `branch` is a problem. Default true; `codebase repo remove` reads old records too. */
  requireBranch?: boolean;
}

/**
 * Reads a `.crossrepo/project.yaml` text. `repos` is a list of names or a map
 * whose keys, as written, are the names. Gives the problem instead when the
 * text is not such a record.
 */
export function parseProjectRecord(
  text: string,
  { requireBranch = true }: ParseRecordOptions = {},
): ProjectRecord | { problem: string } {
  const doc = parseDocument(text);
  const [error] = doc.errors;
  if (error) return { problem: `it is not valid YAML: ${error.message}` };
  if (!isMap(doc.contents)) return { problem: "it is not a map" };
  const branchNode = doc.get("branch", true);
  const branch =
    isScalar(branchNode) && branchNode.value !== null
      ? keyName(branchNode)
      : undefined;
  if (requireBranch && !branch) return { problem: "it has no `branch`" };
  const codebase = doc.get("codebase");
  if (typeof codebase !== "string" || codebase === "") {
    return { problem: "it has no `codebase` path" };
  }
  const created = doc.get("created");
  const base = {
    ...(branch ? { branch } : {}),
    codebase,
    ...(typeof created === "string" ? { created } : {}),
  };
  const repos = doc.get("repos", true);
  const noRepos = {
    problem: "its `repos` is not a list of repo names or a map of repos",
  };
  if (isSeq(repos)) {
    const names = repos.items.map((item) =>
      isScalar(item) && item.value !== null ? keyName(item) : undefined,
    );
    if (names.some((name) => name === undefined)) return noRepos;
    return { ...base, repos: names as string[] };
  }
  if (isMap(repos)) {
    return { ...base, repos: repos.items.map(({ key }) => keyName(key)) };
  }
  return noRepos;
}

/** The text of a new `.crossrepo/project.yaml`: `branch`, `codebase`, `repos`, `created`, in that order. */
export function renderProjectRecord(record: NewProjectRecord): string {
  return [
    `branch: ${scalar(record.branch)}`,
    `codebase: ${scalar(record.codebase)}`,
    "repos:",
    ...record.repos.map((name) => `  - ${scalar(name)}`),
    `created: ${scalar(record.created)}`,
    "",
  ].join("\n");
}
