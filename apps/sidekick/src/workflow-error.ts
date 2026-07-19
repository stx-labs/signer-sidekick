export class OperatorWorkflowError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409 | 422,
    readonly responseCode: string,
    message = responseCode,
  ) {
    super(message);
    this.name = "OperatorWorkflowError";
  }
}
