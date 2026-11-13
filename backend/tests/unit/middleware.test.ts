import { authenticate } from "../../src/middleware/authenticate";
import { requireRole } from "../../src/middleware/authorize";
import { errorHandler } from "../../src/middleware/errorHandler";
import { requireTenant } from "../../src/middleware/tenantScope";
import { mockNext, mockRequest, mockResponse } from "../helpers/http";

jest.mock("../../src/auth/tokens", () => ({ verifyAccessToken: jest.fn() }));
import { verifyAccessToken } from "../../src/auth/tokens";

const errorCode = (body: unknown): unknown => (body as { error: { code: unknown } }).error.code;

describe("requireRole", () => {
  it("allows an explicitly permitted role", () => {
    const next = mockNext();
    requireRole("admin")(mockRequest({ auth: { roles: ["admin"] } }), mockResponse().asResponse(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects a role outside the allow-list", () => {
    const response = mockResponse();
    const next = mockNext();
    requireRole("admin")(mockRequest({ auth: { roles: ["viewer"] } }), response.asResponse(), next);
    expect(response.res.status).toHaveBeenCalledWith(403);
    expect(errorCode(response.body())).toBe("FORBIDDEN");
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a request that was never authenticated", () => {
    const response = mockResponse();
    requireRole("admin")(mockRequest(), response.asResponse(), mockNext());
    expect(response.res.status).toHaveBeenCalledWith(403);
  });
});

describe("authenticate", () => {
  it("rejects a request without a Bearer header", () => {
    const response = mockResponse();
    authenticate(mockRequest(), response.asResponse(), mockNext());
    expect(response.res.status).toHaveBeenCalledWith(401);
    expect(errorCode(response.body())).toBe("UNAUTHENTICATED");
  });

  it("rejects a token that fails verification", () => {
    jest.mocked(verifyAccessToken).mockImplementation(() => {
      throw new Error("jwt expired");
    });
    const response = mockResponse();
    authenticate(mockRequest({}, { Authorization: "Bearer bad" }), response.asResponse(), mockNext());
    expect(response.res.status).toHaveBeenCalledWith(401);
    expect(errorCode(response.body())).toBe("INVALID_TOKEN");
  });

  it("attaches the verified claims and continues", () => {
    const claims = { sub: "u1", tenantId: "t1", roles: ["admin"] };
    jest.mocked(verifyAccessToken).mockReturnValue(claims);
    const req = mockRequest({}, { Authorization: "Bearer good" });
    const next = mockNext();
    authenticate(req, mockResponse().asResponse(), next);
    expect(req.auth).toEqual(claims);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("requireTenant", () => {
  it("copies the tenant id from the token", () => {
    const req = mockRequest({ auth: { sub: "u1", tenantId: "t1", roles: [] } });
    const next = mockNext();
    requireTenant(req, mockResponse().asResponse(), next);
    expect(req.tenantId).toBe("t1");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("blocks a request with no tenant", () => {
    const response = mockResponse();
    requireTenant(mockRequest(), response.asResponse(), mockNext());
    expect(response.res.status).toHaveBeenCalledWith(403);
    expect(errorCode(response.body())).toBe("TENANT_REQUIRED");
  });
});

describe("errorHandler", () => {
  let consoleError: jest.SpyInstance;
  beforeEach(() => {
    consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => consoleError.mockRestore());

  const run = (error: unknown) => {
    const response = mockResponse();
    errorHandler(error, mockRequest({ id: "test-request" }), response.asResponse(), mockNext());
    return response;
  };

  it.each([
    [{ code: "P2002", message: "unique" }, 409, "DUPLICATE_RESOURCE"],
    [{ code: 11000 }, 409, "DUPLICATE_RESOURCE"],
    [{ code: "P2025" }, 404, "RESOURCE_NOT_FOUND"],
    [{ code: "P2003" }, 409, "RELATION_CONFLICT"],
    [{ code: "P1001" }, 503, "DEPENDENCY_UNAVAILABLE"],
    [{ name: "CircuitOpenError" }, 503, "DEPENDENCY_UNAVAILABLE"],
    [{ name: "ValidationError" }, 400, "DATA_VALIDATION_ERROR"],
    [{ name: "AbortError" }, 504, "UPSTREAM_TIMEOUT"],
    [{ type: "entity.parse.failed" }, 400, "INVALID_JSON"],
    [{ type: "entity.too.large" }, 413, "PAYLOAD_TOO_LARGE"],
    [{ status: 422 }, 422, "REQUEST_ERROR"]
  ])("maps %j to %i %s", (error, status, code) => {
    const response = run(error);
    expect(response.res.status).toHaveBeenCalledWith(status);
    expect(errorCode(response.body())).toBe(code);
  });

  it("hides the details of an unknown error behind a 500", () => {
    const response = run(new Error("db password is hunter2"));
    expect(response.res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(response.body())).not.toContain("hunter2");
  });

  it("copes with a thrown string or null", () => {
    expect(run("boom").res.status).toHaveBeenCalledWith(500);
    expect(run(null).res.status).toHaveBeenCalledWith(500);
  });

  it("includes the request id in the body", () => {
    expect((run({ code: "P2002" }).body() as { error: { requestId: string } }).error.requestId).toBe("test-request");
  });
});
