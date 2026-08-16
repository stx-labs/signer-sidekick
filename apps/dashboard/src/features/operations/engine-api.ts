import {
  type EngineApprovalRequest,
  type EngineApprovalResponse,
  type EngineDisableAdapterRequest,
  type EngineDisableAdapterResponse,
  type EngineForceObserveRequest,
  type EngineForceObserveResponse,
  type EngineInvalidateApprovalRequest,
  type EngineInvalidateApprovalResponse,
  type EngineJobDetail,
  type EngineStatus,
  engineApprovalResponseSchema,
  engineDisableAdapterResponseSchema,
  engineForceObserveResponseSchema,
  engineInvalidateApprovalResponseSchema,
  engineJobDetailSchema,
  engineStatusSchema,
  type OperationReadiness,
  operationReadinessSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { apiJson, apiJsonOrUnavailable } from "../../api-client.js";

export async function loadEngineStatus(
  token: string,
  signal?: AbortSignal,
): Promise<EngineStatus | null> {
  return apiJsonOrUnavailable(
    token,
    "/api/v1/engine",
    engineStatusSchema,
    signal ? { signal } : {},
  );
}

export async function loadOperationReadiness(
  token: string,
  signal?: AbortSignal,
): Promise<OperationReadiness | null> {
  return apiJsonOrUnavailable(
    token,
    "/api/v1/operations/readiness",
    operationReadinessSchema,
    signal ? { signal } : {},
  );
}

export async function loadEngineJob(
  token: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<EngineJobDetail> {
  return apiJson(
    token,
    `/api/v1/engine/jobs/${encodeURIComponent(jobId)}`,
    engineJobDetailSchema,
    signal ? { signal } : {},
  );
}

export async function approveEngineJob(
  token: string,
  jobId: string,
  request: EngineApprovalRequest,
): Promise<EngineApprovalResponse> {
  return apiJson(
    token,
    `/api/v1/engine/jobs/${encodeURIComponent(jobId)}/approval`,
    engineApprovalResponseSchema,
    { method: "POST", body: JSON.stringify(request) },
  );
}

export async function invalidateEngineApproval(
  token: string,
  jobId: string,
  request: EngineInvalidateApprovalRequest,
): Promise<EngineInvalidateApprovalResponse> {
  return apiJson(
    token,
    `/api/v1/engine/jobs/${encodeURIComponent(jobId)}/approval/invalidate`,
    engineInvalidateApprovalResponseSchema,
    { method: "POST", body: JSON.stringify(request) },
  );
}

export async function forceEngineObserve(
  token: string,
  request: EngineForceObserveRequest,
): Promise<EngineForceObserveResponse> {
  return apiJson(token, "/api/v1/engine/force-observe", engineForceObserveResponseSchema, {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function disableEngineAdapter(
  token: string,
  adapterId: string,
  request: EngineDisableAdapterRequest,
): Promise<EngineDisableAdapterResponse> {
  return apiJson(
    token,
    `/api/v1/engine/adapters/${encodeURIComponent(adapterId)}/disable`,
    engineDisableAdapterResponseSchema,
    { method: "POST", body: JSON.stringify(request) },
  );
}
