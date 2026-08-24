import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "../src/clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("文本复制", () => {
  it("优先使用标准 Clipboard API", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await copyTextToClipboard("allocube_pat_example");

    expect(writeText).toHaveBeenCalledWith("allocube_pat_example");
  });

  it("标准 API 不可用时回退到选区复制", async () => {
    const textarea = {
      value: "",
      style: {} as Record<string, string>,
      setAttribute: vi.fn(),
      focus: vi.fn(),
      select: vi.fn(),
      setSelectionRange: vi.fn(),
      remove: vi.fn()
    };
    const appendChild = vi.fn();
    const execCommand = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", {
      body: { appendChild },
      createElement: vi.fn().mockReturnValue(textarea),
      execCommand
    });

    await copyTextToClipboard("fallback-token");

    expect(textarea.value).toBe("fallback-token");
    expect(textarea.select).toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(textarea.remove).toHaveBeenCalled();
  });

  it("两种复制方式都失败时返回错误", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }
    });
    vi.stubGlobal("document", {
      body: { appendChild: vi.fn() },
      createElement: vi.fn().mockReturnValue({
        value: "",
        style: {},
        setAttribute: vi.fn(),
        focus: vi.fn(),
        select: vi.fn(),
        setSelectionRange: vi.fn(),
        remove: vi.fn()
      }),
      execCommand: vi.fn().mockReturnValue(false)
    });

    await expect(copyTextToClipboard("blocked")).rejects.toThrow(
      "Clipboard copy was rejected"
    );
  });
});
