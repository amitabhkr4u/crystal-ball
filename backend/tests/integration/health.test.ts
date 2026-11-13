import request from "supertest";
import { app } from "../../index";

describe("health endpoint", () => {
  it("returns ok and capability flags", async () => {
    const response = await request(app).get("/api/health").expect(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.service).toBe("crystal-ball-api");
    expect(response.body.capabilities).toHaveProperty("redis");
  });
});
