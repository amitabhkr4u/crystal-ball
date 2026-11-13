import { errorMessage } from "../../src/utils/errors";
import { hashId } from "../../src/utils/hash";
import { sendError } from "../../src/utils/httpResponse";
import { mockResponse } from "../helpers/http";

describe("hashId", () => {
  it("is stable for the same parts", () => {
    expect(hashId("tenant", "site", 7)).toBe(hashId("tenant", "site", 7));
    expect(hashId("a")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any part changes", () => {
    expect(hashId("tenant", "site-a")).not.toBe(hashId("tenant", "site-b"));
  });
});

describe("sendError", () => {
  it("sends the standard error body", () => {
    const response = mockResponse();
    sendError(response.asResponse(), 400, "BAD", "Nope");
    expect(response.res.status).toHaveBeenCalledWith(400);
    expect(response.body()).toEqual({ error: { code: "BAD", message: "Nope" } });
  });

  it("adds details only when given", () => {
    const response = mockResponse();
    sendError(response.asResponse(), 400, "BAD", "Nope", [{ field: "email" }]);
    expect(response.body()).toEqual({ error: { code: "BAD", message: "Nope", details: [{ field: "email" }] } });
  });
});

describe("errorMessage", () => {
  it("reads Error messages and stringifies everything else", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });
});
