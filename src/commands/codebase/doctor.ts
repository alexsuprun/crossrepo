import { type CommandUnit, codebaseDir } from "../../domain/ctx.ts";
import { codebaseChecks, finishChecks } from "../../services/doctor-checks.ts";

/** `xr codebase doctor`: the codebase checks, each problem with its fix. Reads only: no lock, no change. */
export const codebaseDoctor: CommandUnit = {
  accepts: ["codebase", "project"],
  reportsUnknownKeys: true,
  async run(ctx) {
    const codebase = codebaseDir(ctx.discovery);
    return finishChecks(await codebaseChecks(ctx, codebase));
  },
};
