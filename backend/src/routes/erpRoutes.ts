import { Router } from "express";
import { z } from "zod";
import { findMaintenanceWorkOrders } from "../integrations/erp.service";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/authorize";
import { requireTenant } from "../middleware/tenantScope";
import { errorMessage } from "../utils/errors";
import { sendError } from "../utils/httpResponse";

export const erpRoutes: Router = Router();
const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

// Returns ERP work orders for one asset code.
erpRoutes.get(
  "/work-orders/:assetCode",
  authenticate,
  requireTenant,
  requireRole("admin", "operator", "safety_lead"),
  async (req, res, next) => {
    const parsed = querySchema.safeParse(req.query);
    const { assetCode } = req.params;
    if (!parsed.success || !assetCode || assetCode.length > 100) {
      return sendError(res, 400, "VALIDATION_ERROR", "A valid assetCode and limit between 1 and 100 are required");
    }
    try {
      const workOrders = await findMaintenanceWorkOrders({ assetCode, limit: parsed.data.limit });
      return res.json({
        data: { assetCode, workOrders, count: workOrders.length, source: "external-erp-read-replica" }
      });
    } catch (error) {
      if (/ERP_WORK_ORDERS_TABLE|ERP_.*_COLUMN/.test(errorMessage(error))) {
        return sendError(
          res,
          503,
          "ERP_SCHEMA_MAPPING_REQUIRED",
          "ERP integration is not enabled until the ERP owner confirms its schema mapping"
        );
      }
      return next(error);
    }
  }
);
