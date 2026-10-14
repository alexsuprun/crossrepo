import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { keyName } from "./codebase-config.ts";

/** The part of a project record that `xr codebase repo remove` reads. */
export interface ProjectRecord {
  /** As written: absolute, or relative to the project folder. */
  codebase: string;
  /** The repo names of the project. */
  repos: string[];
}

/**
 * Reads `codebase` and `repos` of a `.crossrepo/project.yaml` text. `repos` is a
 * list of names or a map whose keys, as written, are the names. Gives the
 * problem instead when the text is not such a record.
 */
export function parseProjectRecord(
  text: string,
): ProjectRecord | { problem: string } {
  const doc = parseDocument(text);
  const [error] = doc.errors;
  if (error) return { problem: `it is not valid YAML: ${error.message}` };
  if (!isMap(doc.contents)) return { problem: "it is not a map" };
  const codebase = doc.get("codebase");
  if (typeof codebase !== "string" || codebase === "") {
    return { problem: "it has no `codebase` path" };
  }
  const repos = doc.get("repos", true);
  const noRepos = {
    problem: "its `repos` is not a list of repo names or a map of repos",
  };
  if (isSeq(repos)) {
    const names = repos.items.map((item) =>
      isScalar(item) && item.value !== null ? keyName(item) : undefined,
    );
    if (names.some((name) => name === undefined)) return noRepos;
    return { codebase, repos: names as string[] };
  }
  if (isMap(repos)) {
    return {
      codebase,
      repos: repos.items.map(({ key }) => keyName(key)),
    };
  }
  return noRepos;
}
