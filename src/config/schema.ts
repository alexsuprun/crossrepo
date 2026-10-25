import { z } from "zod";

const text = z.string().nullish();
const list = z.array(z.string()).nullish();
/** A `project.vars` value: numbers and booleans become text. */
const varValue = z
  .union([z.string(), z.number(), z.boolean()])
  .transform(String)
  .nullish();

const repoShape = { remote: text, "default-branch": text, description: text };
const projectShape = {
  "post-create": list,
  "pre-remove": list,
  vars: z.record(z.string(), varValue).nullish(),
};
const rootShape = { name: text, "projects-dir": z.string().min(1).nullish() };

/** One config file. Unknown keys are dropped. `null` means the key is not set. */
export const fileSchema = z.object({
  ...rootShape,
  repos: z.record(z.string(), z.object(repoShape).nullish()).nullish(),
  project: z.object(projectShape).nullish(),
});

/** The same as `fileSchema`, used only to collect unknown keys (D56). */
export const strictFileSchema = z.strictObject({
  ...rootShape,
  repos: z.record(z.string(), z.strictObject(repoShape).nullish()).nullish(),
  project: z.strictObject(projectShape).nullish(),
});

/** The known keys of the map at `path`, for the did-you-mean hint. */
export function knownKeys(path: readonly PropertyKey[]): string[] {
  if (path.length === 0) return Object.keys(fileSchema.shape);
  if (path[0] === "project") return Object.keys(projectShape);
  return Object.keys(repoShape);
}

/** Merged config values. Every key is optional at every level. */
export interface ConfigValues {
  name?: string;
  "projects-dir"?: string;
  repos?: Record<
    string,
    { remote?: string; "default-branch"?: string; description?: string }
  >;
  project?: {
    "post-create"?: string[];
    "pre-remove"?: string[];
    vars?: Record<string, string>;
  };
}
