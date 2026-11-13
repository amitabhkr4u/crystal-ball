import { redisRateLimit } from "../../src/middleware/redisRateLimit";
import { mockNext, mockRequest, mockResponse } from "../helpers/http";

const mockRedis = { incr: jest.fn(), expire: jest.fn() };
jest.mock("../../src/db/redis", () => ({ getRedis: () => mockRedis }));

describe("redisRateLimit", () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("lets a request through under the limit and sets headers", async () => {
    mockRedis.incr.mockResolvedValue(1);
    const response = mockResponse();
    const next = mockNext();
    await redisRateLimit({ max: 3 })(mockRequest({ ip: "1.2.3.4" }), response.asResponse(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(response.res.setHeader).toHaveBeenCalledWith("RateLimit-Remaining", "2");
    expect(mockRedis.expire).toHaveBeenCalledTimes(1);
  });

  it("counts both the IP and the signed-in user", async () => {
    mockRedis.incr.mockResolvedValue(1);
    await redisRateLimit()(
      mockRequest({ ip: "1.2.3.4", auth: { sub: "u1", tenantId: "t1", roles: [] } }),
      mockResponse().asResponse(),
      mockNext()
    );
    expect(mockRedis.incr).toHaveBeenCalledTimes(2);
  });

  it("answers 429 once the limit is passed", async () => {
    mockRedis.incr.mockResolvedValue(4);
    const response = mockResponse();
    const next = mockNext();
    await redisRateLimit({ max: 3 })(mockRequest({ ip: "1.2.3.4" }), response.asResponse(), next);
    expect(response.res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });

  it("fails open outside production when Redis is down", async () => {
    process.env.NODE_ENV = "development";
    mockRedis.incr.mockRejectedValue(new Error("ECONNREFUSED"));
    const next = mockNext();
    await redisRateLimit()(mockRequest({ ip: "1.2.3.4" }), mockResponse().asResponse(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("fails closed with 503 in production when Redis is down", async () => {
    process.env.NODE_ENV = "production";
    mockRedis.incr.mockRejectedValue(new Error("ECONNREFUSED"));
    const response = mockResponse();
    const next = mockNext();
    await redisRateLimit()(mockRequest({ ip: "1.2.3.4" }), response.asResponse(), next);
    expect(response.res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });
});
