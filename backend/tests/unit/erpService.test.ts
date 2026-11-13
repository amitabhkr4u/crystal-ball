import { callApprovedReadProcedure, findMaintenanceWorkOrders } from "../../src/integrations/erp.service";

const mockExecute = jest.fn();
jest.mock("../../src/db/mysql", () => ({ getMysqlReadPool: () => ({ execute: mockExecute }) }));

function lastCall(): [string, unknown[]] {
  return mockExecute.mock.calls[0] as unknown as [string, unknown[]];
}

describe("ERP read-only integration", () => {
  beforeEach(() => {
    process.env.ERP_WORK_ORDERS_TABLE = "maintenance_work_orders";
    process.env.ERP_WORK_ORDER_ID_COLUMN = "work_order_id";
    process.env.ERP_ASSET_CODE_COLUMN = "asset_code";
    process.env.ERP_STATUS_COLUMN = "status";
    process.env.ERP_DESCRIPTION_COLUMN = "description";
    process.env.ERP_SCHEDULED_AT_COLUMN = "scheduled_at";
    process.env.ERP_COMPLETED_AT_COLUMN = "completed_at";
    process.env.ERP_READONLY_PROCEDURES = "sp_asset_work_orders";
  });

  test("uses bound values and clamps the requested page size", async () => {
    mockExecute.mockResolvedValue([[{ workOrderId: 42, assetCode: "A-1", status: "OPEN" }], []]);
    const rows = await findMaintenanceWorkOrders({ assetCode: "A-1", limit: 500 });
    expect(rows).toHaveLength(1);
    expect(lastCall()[0]).toContain("FROM `maintenance_work_orders`");
    expect(lastCall()[1]).toEqual(["A-1", 100]);
  });

  test("defaults the page size to 20 and never goes below 1", async () => {
    mockExecute.mockResolvedValue([[], []]);
    await findMaintenanceWorkOrders({ assetCode: " A-1 " });
    expect(lastCall()[1]).toEqual(["A-1", 20]);
    await findMaintenanceWorkOrders({ assetCode: "A-1", limit: -5 });
    expect(mockExecute.mock.calls[1]?.[1]).toEqual(["A-1", 1]);
  });

  test("rejects a missing or oversized asset code", async () => {
    await expect(findMaintenanceWorkOrders({ assetCode: "  " })).rejects.toThrow("assetCode");
    await expect(findMaintenanceWorkOrders({ assetCode: "A".repeat(101) })).rejects.toThrow("assetCode");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test("rejects untrusted SQL identifiers before query execution", async () => {
    process.env.ERP_WORK_ORDERS_TABLE = "work_orders; DROP TABLE users";
    await expect(findMaintenanceWorkOrders({ assetCode: "A-1" })).rejects.toThrow("ERP_WORK_ORDERS_TABLE");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test("executes only configured stored procedures", async () => {
    mockExecute.mockResolvedValue([[], []]);
    await callApprovedReadProcedure("sp_asset_work_orders", ["A-1"]);
    expect(lastCall()[0]).toBe("CALL `sp_asset_work_orders`(?)");
    expect(lastCall()[1]).toEqual(["A-1"]);
    await expect(callApprovedReadProcedure("sp_drop_everything")).rejects.toThrow("allow-list");
  });
});
