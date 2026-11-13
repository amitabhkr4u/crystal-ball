import request from "supertest";
import { app } from "../../index";

describe("API route contracts", () => {
  it("publishes OpenAPI and liveness endpoints", async () => {
    await request(app).get("/api/health").expect(200);
    const spec = await request(app).get("/api/openapi.json").expect(200);
    expect(spec.body.paths).toHaveProperty("/api/v1/usage/llm/daily");
    await request(app).get("/api/docs/").expect(200);
  });

  it("rejects protected API routes without a bearer token", async () => {
    await request(app).post("/api/v1/alerts/classify").send({}).expect(401);
    await request(app).post("/api/v1/alerts/demo/acknowledge").send({}).expect(401);
    await request(app).post("/api/v1/alerts/demo/override").send({}).expect(401);
    await request(app).post("/api/v1/uploads/presign").send({}).expect(401);
    await request(app).post("/api/v1/uploads/complete").send({}).expect(401);
    await request(app).post("/api/v1/maintenance-documents/index").send({}).expect(401);
    await request(app).get("/api/v1/erp/work-orders/asset-1").expect(401);
    await request(app).get("/api/v1/usage/llm/daily").expect(401);
  });

  it("validates login and refresh request bodies", async () => {
    await request(app).post("/api/v1/auth/login").send({}).expect(400);
    await request(app).post("/api/v1/auth/refresh").send({}).expect(401);
    await request(app).post("/api/v1/auth/logout").expect(204);
  });

  it("validates approval pagination", async () => {
    await request(app).get("/api/approvals?page=0").expect(400);
    await request(app).get("/api/approvals?limit=101").expect(400);
    const response = await request(app).get("/api/approvals?page=1&limit=5").expect(200);
    expect(response.body.pagination.limit).toBe(5);
  });

  it("validates assistant input before starting a stream", async () => {
    await request(app).post("/api/ai/help").send({ question: "x" }).expect(400);
  });
});
