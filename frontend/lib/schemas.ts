import { z } from "zod";

export const ApprovalTypeSchema = z.enum(["Folder", "Video", "PDF", "Image"]);

export const ApprovalSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  type: ApprovalTypeSchema,
  submittedBy: z.string().min(1),
  status: z.literal("Pending Review"),
  statusDate: z.string().min(1)
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const ApprovalsResponseSchema = z.object({ approvals: z.array(ApprovalSchema) });

export const HealthResponseSchema = z.object({ ok: z.literal(true) });

export const PrioritySchema = z.enum(["high", "medium", "low"]);

export const TriageItemSchema = z.object({
  id: z.string().min(1),
  priority: PrioritySchema,
  reason: z.string().trim().min(1).max(240)
});

export const TriageSchema = z.object({
  headline: z.string().trim().min(1).max(200),
  items: z.array(TriageItemSchema).min(1).max(10)
});
export type Triage = z.infer<typeof TriageSchema>;

export const FallbackReasonSchema = z.enum(["no_api_key", "timeout", "llm_error", "invalid_output", "no_policy_match"]);
export type FallbackReason = z.infer<typeof FallbackReasonSchema>;

export const SourceSchema = z.object({ id: z.string(), title: z.string() });

export const MetaEventSchema = z.object({
  fallback: z.boolean(),
  reason: FallbackReasonSchema.optional(),
  promptVersion: z.string().optional(),
  triage: TriageSchema.optional(),
  sources: z.array(SourceSchema).optional()
});
export type MetaEvent = z.infer<typeof MetaEventSchema>;

export const TokenEventSchema = z.object({ text: z.string() });
export const DoneEventSchema = z.object({ fallback: z.boolean() });
export const ErrorEventSchema = z.object({ code: z.string(), message: z.string() });

export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional()
  })
});
