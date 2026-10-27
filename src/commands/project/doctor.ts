import type { CommandUnit } from "../../domain/ctx.ts";
import {
  finishChecks,
  projectDoctorChecks,
} from "../../services/doctor-checks.ts";
import { doctorProjectDir } from "../../services/projects.ts";

/**
 * `xr project doctor [<project>]`: the codebase checks, then the project
 * checks of one project, each problem with its fix. Also runs in a project
 * folder whose record gives no codebase. Reads only: no lock, no change.
 */
export const projectDoctor: CommandUnit = {
  accepts: ["codebase", "project", "broken-project"],
  reportsUnknownKeys: true,
  async run(ctx, args) {
    const [name] = args;
    const project = await doctorProjectDir(ctx, name, {
      message: "Pick the project to check",
      missing: "Give the project to check.",
      hint: "xr project doctor <project>",
    });
    const codebase =
      "codebase" in ctx.discovery ? ctx.discovery.codebase : undefined;
    return finishChecks(await projectDoctorChecks(ctx, project, codebase), [
      { type: "value", key: "project", value: { path: project } },
    ]);
  },
};
