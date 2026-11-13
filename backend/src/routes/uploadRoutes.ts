import { randomUUID } from "node:crypto";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type HeadObjectCommandOutput
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/authorize";
import { requireTenant } from "../middleware/tenantScope";
import { matchesFileSignature, scanReadable } from "../security/clamavScanner";
import { errorMessage } from "../utils/errors";
import { sendError } from "../utils/httpResponse";
import { getAuth, getTenantId } from "../utils/requestContext";

export const uploadRoutes: Router = Router();
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const SIGNATURE_BYTES = 16;

const requestSchema = z.object({
  fileName: z.string().min(1).max(180),
  contentType: z.enum(["image/jpeg", "image/png", "application/pdf", "video/mp4"]),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES)
});
const completeSchema = z.object({ objectKey: z.string().min(1).max(500) });

let s3: S3Client | undefined;

// Returns the shared S3 client.
function getS3(): S3Client {
  s3 ??= new S3Client({
    region: env.AWS_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: Boolean(env.S3_ENDPOINT)
  });
  return s3;
}

// Checks that the uploaded object matches what was declared.
function metadataIsValid(head: HeadObjectCommandOutput, tenantId: string): boolean {
  const meta = head.Metadata ?? {};
  const size = head.ContentLength;
  return (
    meta.tenantid === tenantId &&
    size !== undefined &&
    size > 0 &&
    size <= MAX_UPLOAD_BYTES &&
    size === Number(meta.expectedsize) &&
    head.ContentType === meta.declaredtype
  );
}

// The S3 body type is a union of stream shapes; ClamAV scanning needs an async-iterable stream.
function isScannable(body: unknown): body is AsyncIterable<Buffer | Uint8Array | string> {
  return typeof body === "object" && body !== null && Symbol.asyncIterator in body;
}

// Creates a short-lived upload link into the quarantine folder.
uploadRoutes.post("/presign", authenticate, requireTenant, requireRole("admin", "operator"), async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "VALIDATION_ERROR", "Unsupported file metadata or file size");
  }
  const bucket = env.S3_BUCKET;
  if (!bucket || !env.AWS_REGION) {
    return sendError(res, 503, "STORAGE_NOT_CONFIGURED", "Object storage is not configured");
  }
  const { fileName, contentType, sizeBytes } = parsed.data;
  const tenantId = getTenantId(req);
  try {
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = `quarantine/${tenantId}/${randomUUID()}-${safeName}`;
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: sizeBytes,
      Metadata: {
        tenantid: tenantId,
        uploadedby: getAuth(req).sub,
        expectedsize: String(sizeBytes),
        declaredtype: contentType
      }
    });
    const uploadUrl = await getSignedUrl(getS3(), command, { expiresIn: 300 });
    return res.status(201).json({
      data: {
        uploadUrl,
        objectKey: key,
        expiresIn: 300,
        status: "quarantined",
        nextStep:
          "Upload the object, then call POST /api/v1/uploads/complete. Files are not available to the application until ClamAV and file-signature checks pass."
      }
    });
  } catch {
    return sendError(res, 502, "STORAGE_ERROR", "Could not create upload URL");
  }
});

// Scans a quarantined upload and moves it to clean storage.
uploadRoutes.post("/complete", authenticate, requireTenant, requireRole("admin", "operator"), async (req, res) => {
  const tenantId = getTenantId(req);
  const parsed = completeSchema.safeParse(req.body);
  if (
    !parsed.success ||
    !parsed.data.objectKey.startsWith(`quarantine/${tenantId}/`) ||
    parsed.data.objectKey.includes("..")
  ) {
    return sendError(
      res,
      400,
      "INVALID_OBJECT_KEY",
      "A quarantine object key belonging to the authenticated tenant is required"
    );
  }
  const bucket = env.S3_BUCKET;
  if (!bucket || !env.AWS_REGION) {
    return sendError(res, 503, "STORAGE_NOT_CONFIGURED", "Object storage is not configured");
  }
  if (!env.CLAMAV_HOST) {
    return sendError(res, 503, "MALWARE_SCANNER_UNAVAILABLE", "ClamAV is not configured; object remains quarantined");
  }

  const { objectKey } = parsed.data;
  try {
    const client = getS3();
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    if (!metadataIsValid(head, tenantId)) {
      return sendError(
        res,
        422,
        "UPLOAD_METADATA_INVALID",
        "Uploaded object metadata or size is invalid; object remains quarantined"
      );
    }

    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
    if (!isScannable(object.Body)) {
      return sendError(res, 502, "STORAGE_READ_FAILED", "Uploaded object could not be read for scanning");
    }

    const prefixParts: Buffer[] = [];
    let prefixLength = 0;
    const verdict = await scanReadable(object.Body, {
      onChunk(chunk) {
        if (prefixLength >= SIGNATURE_BYTES) return;
        const part = chunk.subarray(0, SIGNATURE_BYTES - prefixLength);
        prefixParts.push(part);
        prefixLength += part.length;
      }
    });

    if (!verdict.clean && !/FOUND/.test(verdict.response)) {
      return sendError(
        res,
        503,
        "MALWARE_SCANNER_UNAVAILABLE",
        "ClamAV did not return a clean or infected verdict; object remains quarantined"
      );
    }
    if (!verdict.clean) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
      return sendError(res, 422, "MALWARE_DETECTED", "The uploaded object failed malware scanning and was deleted");
    }
    if (!matchesFileSignature(head.ContentType || "", Buffer.concat(prefixParts))) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
      return sendError(
        res,
        415,
        "FILE_SIGNATURE_MISMATCH",
        "The file contents do not match the declared MIME type; object was deleted"
      );
    }

    const cleanKey = objectKey.replace(/^quarantine\//, "clean/");
    const copySource = `${bucket}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: cleanKey,
        CopySource: copySource,
        MetadataDirective: "COPY",
        TaggingDirective: "REPLACE",
        Tagging: "scan-status=clean"
      })
    );
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
    return res.json({
      data: {
        status: "clean",
        objectKey: cleanKey,
        scannedAt: new Date().toISOString(),
        scanner: "ClamAV",
        signatureVerified: true
      }
    });
  } catch (error) {
    if (/CLAMAV_HOST|ClamAV/.test(errorMessage(error))) {
      return sendError(
        res,
        503,
        "MALWARE_SCANNER_UNAVAILABLE",
        "Malware scan could not complete; object remains quarantined"
      );
    }
    return sendError(
      res,
      502,
      "UPLOAD_SCAN_FAILED",
      "Upload verification failed; object remains quarantined unless explicitly rejected"
    );
  }
});
