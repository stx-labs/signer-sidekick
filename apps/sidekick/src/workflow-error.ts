export class OperatorWorkflowError extends Error {
  /** Returned to the authenticated operator; keep this message safe to expose. */
  constructor(
    readonly statusCode: 400 | 404 | 409 | 422 | 503,
    readonly responseCode: string,
    message = responseCode,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "OperatorWorkflowError";
  }
}
