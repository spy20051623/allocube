export class BusinessError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
    public details?: unknown,
    public code?: string
  ) {
    super(message);
  }
}
