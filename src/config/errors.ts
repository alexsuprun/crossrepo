export type ConfigErrorKind = "conflict" | "invalid" | "not-a-codebase";

export interface ConfigErrorInit {
  kind: ConfigErrorKind;
  message: string;
  hint?: string;
}

/** A real config or discovery failure. `cli` maps it to `XrError`, which `config` may not import. */
export class ConfigError extends Error {
  readonly kind: ConfigErrorKind;
  readonly hint?: string;

  constructor({ kind, message, hint }: ConfigErrorInit) {
    super(message);
    this.name = "ConfigError";
    this.kind = kind;
    this.hint = hint;
  }
}

export const CODEBASE_PATH_HINT =
  "Run xr in a codebase folder, or use `--codebase-path <path>`.";
