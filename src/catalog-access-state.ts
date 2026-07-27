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
  label: "管理员" | "使用者" | "审核中" | "无权限";
  action: CatalogAccessAction;
  actionLabel: "申请" | "撤回" | "退出" | null;
} {
  if (input.userRole === "SYSTEM_ADMIN" || input.isManager) {
    return {
      state: "ADMIN",
      label: "管理员",
      action: input.userRole === "SYSTEM_ADMIN" ? null : "EXIT",
      actionLabel: input.userRole === "SYSTEM_ADMIN" ? null : "退出"
    };
  }
  if (input.hasAccess) {
    return {
      state: "USER",
      label: "使用者",
      action: "EXIT",
      actionLabel: "退出"
    };
  }
  if (input.hasPendingRequest) {
    return {
      state: "PENDING",
      label: "审核中",
      action: "WITHDRAW",
      actionLabel: "撤回"
    };
  }
  return {
    state: "NO_ACCESS",
    label: "无权限",
    action: "APPLY",
    actionLabel: "申请"
  };
}
