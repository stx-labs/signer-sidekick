import {
  type EngineDisableAdapterRequest,
  type EngineDisableAdapterResponse,
  type EngineForceObserveRequest,
  type EngineForceObserveResponse,
  type EngineJobDetail,
  type EngineStatus,
  engineDisableAdapterResponseSchema,
  engineForceObserveResponseSchema,
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
