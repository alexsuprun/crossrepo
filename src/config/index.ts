export { type Discovery, discover } from "./discovery.ts";
export {
  CODEBASE_PATH_HINT,
  ConfigError,
  type ConfigErrorKind,
} from "./errors.ts";
export {
  type ConfigEntry,
  type ConfigSource,
  DEFAULT_PROJECTS_DIR,
  type LoadedConfig,
  loadConfig,
  type UnknownKey,
} from "./load.ts";
export type { ConfigValues } from "./schema.ts";
export { writeFileAtomic } from "./write.ts";
