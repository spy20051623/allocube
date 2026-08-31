import { tr } from "./i18n/index";
export type CatalogAccessState =
  | "ADMIN"
  | "USER"
  | "PENDING"
  | "NO_ACCESS";

export type CatalogAccessAction = "APPLY" | "WITHDRAW" | "EXIT" | null;

export function resolveCatalogAccessDisplay(input: {
  userRole: string;
  isManager: boolean;
  hasAccess: boolean;
  hasPendingRequest: boolean;
}): {
  state: CatalogAccessState;
  label: string;
  action: CatalogAccessAction;
  actionLabel: string | null;
} {
  if (input.userRole === "SYSTEM_ADMIN" || input.isManager) {
    return {
      state: "ADMIN",
      label: tr("管理员"),
      action: input.userRole === "SYSTEM_ADMIN" ? null : "EXIT",
      actionLabel: input.userRole === "SYSTEM_ADMIN" ? null : tr("退出")
    };
  }
  if (input.hasAccess) {
    return {
      state: "USER",
      label: tr("使用者"),
      action: "EXIT",
      actionLabel: tr("退出")
    };
  }
  if (input.hasPendingRequest) {
    return {
      state: "PENDING",
      label: tr("审核中"),
      action: "WITHDRAW",
      actionLabel: tr("撤回")
    };
  }
  return {
    state: "NO_ACCESS",
    label: tr("无权限"),
    action: "APPLY",
    actionLabel: tr("申请")
  };
}
