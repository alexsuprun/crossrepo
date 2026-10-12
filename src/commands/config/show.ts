import type { CommandUnit, ConfigEntry } from "../../domain/ctx.ts";
import type { FieldItem } from "../../domain/report.ts";

/** `xr config show`: every merged value with the file that gives it (D25, D42). */
export const configShow: CommandUnit = {
  accepts: ["codebase", "project"],
  run({ config }) {
    return {
      blocks: [
        { type: "fields", key: "entries", items: config.entries.map(toItem) },
      ],
    };
  },
};

function toItem({ key, value, source, resolved }: ConfigEntry): FieldItem {
  return {
    key,
    value,
    source: source.kind === "file" ? { path: source.path } : "default",
    ...(resolved === undefined
      ? {}
      : { extra: { resolved: { path: resolved } } }),
  };
}
