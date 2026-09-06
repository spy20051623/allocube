import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../src/api";
import { canSyncDraft, claimEdit, hasUncertainEdit, markEditUncertain, editWithRetainedReason, confirmedEdit, EditCancelled, EditOutcomeUnknown } from "../src/edit-conflict";

afterEach(() => vi.useRealTimers());
const conflict = () => new ApiError("changed", 409, undefined, "EDIT_CONFLICT");

describe("非日历编辑提交", () => {
  it("跨编辑器实例防重复提交，结果不明在释放后仍保留", () => {
    const path = "/test/retained-uncertain";
    const release = claimEdit(path);
    expect(() => claimEdit(path)).toThrow(EditCancelled);
    release();
    const releaseAgain = claimEdit(path);
    markEditUncertain(path); releaseAgain();
    expect(hasUncertainEdit([path])).toBe(true);
    expect(() => claimEdit(path)).toThrow(EditOutcomeUnknown);
  });

  it("取消覆盖回到原因草稿，仅用户再次提交后才继续", async () => {
    let answer!: (value: RequestInit | null) => void;
    const run = vi.fn().mockRejectedValueOnce(new EditCancelled()).mockResolvedValueOnce({ ok: true });
    const resume = vi.fn(() => new Promise<RequestInit | null>(resolve => { answer = resolve; }));
    const original = { body: JSON.stringify({ reason: "original", expectedVersion: 1 }) };
    const result = editWithRetainedReason(original, run, resume);
    await vi.waitFor(() => expect(resume).toHaveBeenCalledWith(original));
    expect(run).toHaveBeenCalledTimes(1);
    const updated = { body: JSON.stringify({ reason: "revised", expectedVersion: 1 }) };
    answer(updated);
    expect(await result).toEqual({ ok: true });
    expect(run).toHaveBeenLastCalledWith(updated);
  });

  it("退出原因草稿不重发，结果不明也不返回原因框诱导重发", async () => {
    const run = vi.fn().mockRejectedValue(new EditCancelled());
    await expect(editWithRetainedReason({}, run, async () => null)).rejects.toBeInstanceOf(EditCancelled);
    expect(run).toHaveBeenCalledTimes(1);
    const resume = vi.fn();
    await expect(editWithRetainedReason({}, async () => { throw new EditOutcomeUnknown(); }, resume)).rejects.toBeInstanceOf(EditOutcomeUnknown);
    expect(resume).not.toHaveBeenCalled();
  });

  it("取消保留原始载荷，不查询最新内容、不重发", async () => {
    const send = vi.fn().mockRejectedValue(conflict());
    const body = JSON.stringify({ name: "draft", expectedVersion: 1 });
    await expect(confirmedEdit("/admin/machines/1", { method: "PATCH", body }, async () => false,
      new AbortController().signal, send as typeof api)).rejects.toBeInstanceOf(EditCancelled);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1].body).toBe(body);
  });

  it("确认可等待超过网络超时；仅第二次发送显式覆盖，保留原提交", async () => {
    vi.useFakeTimers();
    let answer!: (value: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>(resolve => { answer = resolve; }));
    const send = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValueOnce({ version: 9 });
    const body = JSON.stringify({ name: "draft", expectedVersion: 1 });
    const result = confirmedEdit("/edit", { method: "PATCH", body }, confirm, new AbortController().signal, send as typeof api);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(send).toHaveBeenCalledTimes(1);
    answer(true);
    expect(await result).toEqual({ version: 9 });
    expect(send.mock.calls.map(call => new Headers(call[1].headers).get("x-allocube-overwrite"))).toEqual([null, "true"]);
    expect(send.mock.calls.every(call => call[1].body === body)).toBe(true);
  });

  it.each([new ApiError("unique", 409, undefined, "DUPLICATE"), new ApiError("denied", 403), new ApiError("gone", 404)])(
    "业务约束及权限错误不显示覆盖确认：%s", async error => {
      const send = vi.fn().mockRejectedValue(error), confirm = vi.fn();
      await expect(confirmedEdit("/edit", { method: "PUT" }, confirm, new AbortController().signal, send as typeof api)).rejects.toBe(error);
      expect(confirm).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledTimes(1);
    });

  it.each([new TypeError("network lost"), new ApiError("proxy unavailable", 502)])("结果不明时绝不自动重发：%s", async error => {
    const send = vi.fn().mockRejectedValue(error), confirm = vi.fn();
    await expect(confirmedEdit("/edit", { method: "PUT" }, confirm, new AbortController().signal, send as typeof api)).rejects.toBeInstanceOf(EditOutcomeUnknown);
    expect(send).toHaveBeenCalledTimes(1); expect(confirm).not.toHaveBeenCalled();
  });

  it("确认后请求挂起超时，不进行第三次提交", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValueOnce(conflict()).mockImplementation(() => new Promise(() => {}));
    const result = confirmedEdit("/edit", { method: "PUT" }, async () => true, new AbortController().signal, send as typeof api);
    const rejected = expect(result).rejects.toBeInstanceOf(EditOutcomeUnknown);
    await vi.advanceTimersByTimeAsync(15_001); await rejected;
    expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1][1].signal.aborted).toBe(true);
  });

  it("确认时页面卸载，即使随后同意也不会覆盖", async () => {
    const controller = new AbortController(), send = vi.fn().mockRejectedValue(conflict());
    await expect(confirmedEdit("/edit", { method: "PUT" }, async () => { controller.abort(); return true; }, controller.signal, send as typeof api)).rejects.toBeInstanceOf(EditCancelled);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("multipart 图片和元数据在确认后保持完整", async () => {
    const body = new FormData(); body.set("metadata", '{"title":"draft"}'); body.append("images", new Blob(["image"]), "image.png");
    const send = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValueOnce({ saved: true });
    await confirmedEdit("/feedback/1", { method: "PUT", body }, async () => true, new AbortController().signal, send as typeof api);
    expect(send.mock.calls[1][1].body.get("metadata")).toBe('{"title":"draft"}');
    expect(await send.mock.calls[1][1].body.get("images").text()).toBe("image");
  });

  it("仅未修改且未提交的草稿可自动同步", () => {
    expect(canSyncDraft({ name: "saved" }, { name: "saved" }, false)).toBe(true);
    expect(canSyncDraft({ name: "saved" }, { name: "draft" }, false)).toBe(false);
    expect(canSyncDraft({ name: "saved" }, { name: "saved" }, true)).toBe(false);
  });
});
