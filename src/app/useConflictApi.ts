import { useEditConflict } from "../useEditConflict";
import { tr } from "../i18n/index";
import { useRef } from "react";
import { jsonBody } from "../api";
import { useAppDialog, type PromptDialogOptions } from "../components/dialogs";

export function useConflictApi() {
  const dialog = useAppDialog();
  const reasonPrompt = useRef<{ options: PromptDialogOptions; value: string } | null>(null);
  const mutation = useEditConflict((impact, signal) => dialog.confirm({
    signal,
    title: tr("数据已更新"),
    message: impact
      ? tr("占用情况已变化。是否按最新影响范围执行本次操作？取消将保留当前输入。")
      : tr("数据已在其他页面或设备更新。是否用本次提交的内容覆盖对应数据？取消将保留当前草稿。"),
    confirmLabel: tr("确认覆盖"), tone: "danger"
  }), async (options, signal) => {
    if (typeof options.body !== "string" || !reasonPrompt.current) return null;
    const body = JSON.parse(options.body);
    if (typeof body.reason !== "string" || body.reason !== reasonPrompt.current.value) return null;
    const prompt = reasonPrompt.current;
    const value = await dialog.prompt({ ...prompt.options, initialValue: body.reason, signal });
    if (value === null || signal.aborted) return null;
    reasonPrompt.current = { options: prompt.options, value };
    return { ...options, body: jsonBody({ ...body, reason: value }) };
  });
  const prompt = async (options: PromptDialogOptions) => {
    const value = await dialog.prompt(options);
    reasonPrompt.current = value === null ? null : { options, value };
    return value;
  };
  return { ...mutation, dialog: { ...dialog, prompt } };
}
