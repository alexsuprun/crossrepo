import type { CommandUnit } from "../../domain/ctx.ts";
import { XrError } from "../../errors/index.ts";
import {
  codebaseChecks,
  finishChecks,
  projectDoctorChecks,
} from "../../services/doctor-checks.ts";

/**
 * `xr doctor`: in a project folder (also a broken one) the `xr project doctor`
 * checks of that project, in a codebase folder the `xr codebase doctor`
 * checks, after a leading `scope` value. Reads only: no lock, no change.
 */
export const xrDoctor: CommandUnit = {
  accepts: ["codebase", "project", "broken-project"],
  reportsUnknownKeys: true,
  refuse(discovery) {
    return new XrError({
      code: "not-a-codebase",
      message: `${discovery.dir} is not a crossrepo codebase or project.`,
      hint: "Run it in a codebase folder or a project folder, or give `--codebase-path`.",
    });
  },
  async run(ctx) {
    const discovery = ctx.discovery;
    if (discovery.kind === "codebase") {
      return finishChecks(await codebaseChecks(ctx, discovery.codebase), [
        { type: "value", key: "scope", value: "codebase" },
      ]);
    }
    const project = discovery.dir;
    const codebase = "codebase" in discovery ? discovery.codebase : undefined;
    return finishChecks(await projectDoctorChecks(ctx, project, codebase), [
      { type: "value", key: "scope", value: "project" },
      { type: "value", key: "project", value: { path: project } },
    ]);
  },
};
