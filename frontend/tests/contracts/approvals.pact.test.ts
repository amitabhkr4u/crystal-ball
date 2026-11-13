// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PactV3, Matchers } from "@pact-foundation/pact";

const { eachLike, string } = Matchers;

describe("Approvals API consumer contract", () => {
  it("returns a stable approval list contract", async () => {
    const provider = new PactV3({ consumer: "CrystalBallWeb", provider: "CrystalBallAPI", dir: "./pacts" });
    provider.addInteraction({
      states: [{ description: "there are pending approvals" }],
      uponReceiving: "a request for pending approvals",
      withRequest: { method: "GET", path: "/api/approvals" },
      willRespondWith: {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: {
          approvals: eachLike({
            id: string("APR-001"),
            title: string("Safety checklist"),
            type: string("PDF"),
            status: string("Pending Review")
          })
        }
      }
    });

    await provider.executeTest(async (mockServer) => {
      const response = await fetch(`${mockServer.url}/api/approvals`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body.approvals)).toBe(true);
      expect(body.approvals[0]).toMatchObject({
        id: expect.any(String),
        title: expect.any(String),
        type: expect.any(String),
        status: expect.any(String)
      });
    });
  });
});
