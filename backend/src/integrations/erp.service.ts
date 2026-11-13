import type { RowDataPacket } from "mysql2/promise";
import { getMysqlReadPool } from "../db/mysql";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface WorkOrderRow extends RowDataPacket {
  workOrderId: string | number;
  assetCode: string;
  status: string;
  description: string | null;
  scheduledAt: Date | null;
  completedAt: Date | null;
}

interface ErpMapping {
  table: string;
  id: string;
  asset: string;
  status: string;
  description: string;
  scheduled: string;
  completed: string;
}

// Validates an env-configured SQL name and wraps it in backticks.
function identifier(name: string | undefined, envName: string): string {
  if (!name || !IDENTIFIER.test(name)) {
    throw new Error(`${envName} must be configured as a simple SQL identifier before ERP queries are enabled`);
  }
  return `\`${name}\``;
}

// Builds the validated table and column mapping from env settings (read per call, not cached).
function mapping(): ErpMapping {
  return {
    table: identifier(process.env.ERP_WORK_ORDERS_TABLE, "ERP_WORK_ORDERS_TABLE"),
    id: identifier(process.env.ERP_WORK_ORDER_ID_COLUMN, "ERP_WORK_ORDER_ID_COLUMN"),
    asset: identifier(process.env.ERP_ASSET_CODE_COLUMN, "ERP_ASSET_CODE_COLUMN"),
    status: identifier(process.env.ERP_STATUS_COLUMN, "ERP_STATUS_COLUMN"),
    description: identifier(process.env.ERP_DESCRIPTION_COLUMN, "ERP_DESCRIPTION_COLUMN"),
    scheduled: identifier(process.env.ERP_SCHEDULED_AT_COLUMN, "ERP_SCHEDULED_AT_COLUMN"),
    completed: identifier(process.env.ERP_COMPLETED_AT_COLUMN, "ERP_COMPLETED_AT_COLUMN")
  };
}

// Reads work orders for one asset from the ERP read replica.
export async function findMaintenanceWorkOrders(input: { assetCode: string; limit?: number }): Promise<WorkOrderRow[]> {
  const { assetCode, limit } = input;
  if (typeof assetCode !== "string" || !assetCode.trim() || assetCode.length > 100) {
    throw new TypeError("A valid assetCode is required");
  }
  const safeLimit = Math.min(Math.max(Math.trunc(limit ?? 20), 1), 100);
  const columns = mapping();
  const sql = `SELECT ${columns.id} AS workOrderId, ${columns.asset} AS assetCode,
      ${columns.status} AS status, ${columns.description} AS description,
      ${columns.scheduled} AS scheduledAt, ${columns.completed} AS completedAt
    FROM ${columns.table}
    WHERE ${columns.asset} = ?
    ORDER BY ${columns.scheduled} DESC
    LIMIT ?`;
  const [rows] = await getMysqlReadPool().execute<WorkOrderRow[]>(sql, [assetCode.trim(), safeLimit]);
  return rows;
}

// Runs a stored procedure only if it is on the allow-list.
export async function callApprovedReadProcedure(
  procedure: string,
  parameters: readonly (string | number)[] = []
): Promise<unknown> {
  const allowed = new Set(
    (process.env.ERP_READONLY_PROCEDURES || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  if (!allowed.has(procedure) || !IDENTIFIER.test(procedure)) {
    throw new Error("Stored procedure is not present in ERP_READONLY_PROCEDURES allow-list");
  }
  const placeholders = parameters.map(() => "?").join(", ");
  const [rows] = await getMysqlReadPool().execute(`CALL \`${procedure}\`(${placeholders})`, [...parameters]);
  return rows;
}
