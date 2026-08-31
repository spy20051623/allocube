import serverEnglish from "../src/i18n/server-en.json" with { type: "json" };
import { createSystemMessageCatalog } from "../src/shared/system-message.js";

const systemMessages = createSystemMessageCatalog(serverEnglish);

export class BusinessError extends Error {
  public code: string;
  public params: Record<string, string | number | boolean | null>;
  public messageCode: string;

  constructor(
    message: string,
    public statusCode = 400,
    public details?: unknown,
    code?: string,
    params?: Record<string, string | number | boolean | null>
  ) {
    super(message);
    const resolved = systemMessages.resolve(message);
    this.code = code ?? resolved?.code ?? "BUSINESS_RULE_VIOLATION";
    this.params = params ?? resolved?.params ?? {};
    this.messageCode = resolved?.code ?? `errors.${this.code.toLocaleLowerCase()}`;
  }
}
