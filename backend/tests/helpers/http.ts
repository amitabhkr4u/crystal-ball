import type { NextFunction, Request, Response } from "express";

// A minimal Express response double that records status, headers and the JSON body.
export function mockResponse() {
  const res = { status: jest.fn(), json: jest.fn(), setHeader: jest.fn() };
  res.status.mockReturnValue(res);
  return {
    res,
    asResponse: (): Response => res as unknown as Response,
    /** The first argument passed to res.json(), or undefined if it was not called. */
    body: (): unknown => res.json.mock.calls[0]?.[0]
  };
}

// Builds a request double from the few fields a middleware reads.
export function mockRequest(fields: Record<string, unknown> = {}, headers: Record<string, string> = {}): Request {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ...fields,
    get: (name: string): string | undefined => lower[name.toLowerCase()]
  } as unknown as Request;
}

export const mockNext = (): NextFunction => jest.fn();
