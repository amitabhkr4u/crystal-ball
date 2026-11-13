import type { Approval } from "../data/approvals";

export const approvalReviewPrompt = Object.freeze({
  version: "approval-review.v1",
  system: Object.freeze({
    summary: (policy: string, approvals: readonly Approval[]): string =>
      `Prioritize these pending approvals using this policy. Return a concise operator summary. Policy: ${policy}\nApprovals: ${JSON.stringify(approvals)}`,
    greeting: (_policy: string, approvals: readonly Approval[]): string =>
      `Greet the operator briefly. There are ${approvals.length} pending approvals.`,
    help: (policy: string): string => `Answer only from this policy. If unsupported, say so. Policy: ${policy}`,
    teach: (policy: string): string => `Teach the operator how to review approvals using this policy: ${policy}`,
    talk: (policy: string, approvals: readonly Approval[]): string =>
      `You are the Crystal Ball approvals assistant. Use this policy: ${policy}\nApprovals: ${JSON.stringify(approvals)}`
  })
});
