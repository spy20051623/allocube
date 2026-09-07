import { registerAuditRoutes } from "./audit-routes.js";
import { registerReportRoutes } from "./report-routes.js";
import type { FastifyInstance } from "fastify";
import { registerUsersAdminRoutes } from "./admin/users-routes.js";
import { registerMachinesAdminRoutes } from "./admin/machines-routes.js";
import { registerAccessAdminRoutes } from "./admin/access-routes.js";
import { registerResourcesAdminRoutes } from "./admin/resources-routes.js";
import { registerUnavailabilityAdminRoutes } from "./admin/unavailability-routes.js";
import { registerSmtpAdminRoutes } from "./admin/smtp-routes.js";
import { registerSettingsAdminRoutes } from "./admin/settings-routes.js";

export function registerAdminRoutes(app: FastifyInstance, publishRevision: (revision: number) => void) {
  registerUsersAdminRoutes(app, publishRevision);
  registerMachinesAdminRoutes(app, publishRevision);
  registerAccessAdminRoutes(app, publishRevision);
  registerResourcesAdminRoutes(app, publishRevision);
  registerUnavailabilityAdminRoutes(app, publishRevision);
  registerSmtpAdminRoutes(app);
  registerSettingsAdminRoutes(app);
  registerReportRoutes(app);
  registerAuditRoutes(app);
}
