export class OperatorWorkflowError extends Error {
  /** Returned to the authenticated operator; keep this message safe to expose. */
  constructor(
    readonly statusCode: 400 | 404 | 409 | 422,
    readonly responseCode: string,
    message = responseCode,
  ) {
    super(message);
    this.name = "OperatorWorkflowError";
  }
}
