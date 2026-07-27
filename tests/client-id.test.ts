import { describe, expect, it } from "vitest";
import { createClientId } from "../src/client-id";

describe("客户端临时 ID", () => {
  it("优先使用浏览器原生 randomUUID", () => {
    expect(
      createClientId({
        randomUUID: () => "00000000-0000-4000-8000-000000000001"
      })
    ).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("在非安全上下文缺少 randomUUID 时生成 UUID v4", () => {
    const id = createClientId({
      getRandomValues: (bytes) => {
        bytes.forEach((_, index) => {
          bytes[index] = index;
        });
        return bytes;
      }
    });

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});
