import { tr } from "./i18n/index";

function unknownStatus() {
  return tr("状态未知");
}

export function userStatusLabel(status: string) {
  return (
    {
      PENDING_APPROVAL: tr("等待审核"),
      CHANGES_REQUESTED: tr("需要修改"),
      ACTIVE: tr("status.enabled"),
      DISABLED: tr("status.disabled")
    } as Record<string, string>
  )[status] ?? unknownStatus();
}

export function resourceGroupStatusLabel(status: string) {
  return (
    {
      ACTIVE: tr("status.enabled"),
      DISABLED: tr("status.disabled")
    } as Record<string, string>
  )[status] ?? unknownStatus();
}

export function reservationStatusLabel(
  status: string,
  startAt: string,
  endAt: string,
  now: number
) {
  if (status === "CANCELLED") return tr("已取消");
  if (status === "CANCELLED_UNAVAILABILITY") return tr("因维护取消");
  if (status !== "CONFIRMED") return unknownStatus();
  if (new Date(endAt).getTime() <= now) return tr("已结束");
  if (new Date(startAt).getTime() <= now) return tr("进行中");
  return tr("未开始");
}

export function reservationStatusClass(
  status: string,
  startAt: string,
  endAt: string,
  now: number
) {
  if (status === "CANCELLED" || status === "CANCELLED_UNAVAILABILITY") {
    return "cancelled";
  }
  if (status !== "CONFIRMED") return "";
  if (new Date(endAt).getTime() <= now) return "done";
  if (new Date(startAt).getTime() <= now) return "active";
  return "upcoming";
}

export function auditActionLabel(action: string) {
  return (
    {
      PASSWORD_RESET_LINK_CREATE: tr("创建密码重置链接"),
      RESOURCE_POOL_CREATE: tr("创建资源项"),
      RESOURCE_POOL_UPDATE: tr("修改资源项"),
      EMAIL_PREFERENCES_UPDATE: tr("修改邮件通知偏好"),
      PASSWORD_CHANGE: tr("修改密码"),
      REGISTRATION_PROFILE_EDIT: tr("修改注册资料"),
      PASSWORD_RESET: tr("重置密码"),
      REPORT_REBUILD_REQUEST: tr("发起全部重新统计"),
      REPORT_REBUILD_SUCCEEDED: tr("全部重新统计完成"),
      REPORT_REBUILD_FAILED: tr("全部重新统计失败"),
      USER_REGISTER: tr("提交注册申请"),
      USER_LOGIN: tr("用户登录"),
      USER_STATUS_CHANGE: tr("更改用户状态"),
      USER_DELETE: tr("永久删除用户"),
      USER_APPROVE: tr("通过注册申请"),
      USER_RETURN: tr("要求修改注册信息"),
      USER_REJECT: tr("拒绝注册"),
      USERNAME_CHANGE: tr("修改用户名"),
      EMAIL_CHANGE: tr("修改邮箱"),
      EMAIL_RECOVERY: tr("恢复用户邮箱"),
      PROFILE_CHANGE_REQUEST: tr("提交资料修改"),
      PROFILE_CHANGE_WITHDRAW: tr("撤回资料修改"),
      PROFILE_CHANGE_APPROVE: tr("通过资料修改"),
      PROFILE_CHANGE_REJECT: tr("拒绝资料修改"),
      MACHINE_CREATE: tr("创建机器"),
      TERMINAL_REGISTER: tr("登记终端"),
      SSH_KEY_ADD: tr("添加个人公钥"),
      SSH_KEY_REMOVE: tr("删除个人公钥"),
      SSH_KEY_ACTIVATE: tr("激活机器公钥"),
      SSH_KEY_DEACTIVATE: tr("停用机器公钥"),
      TERMINAL_DISABLE: tr("停用终端"),
      TERMINAL_CA_UPDATE: tr("更新终端 CA 证书"),
      TERMINAL_CREATE: tr("新建机器账户"),
      TERMINAL_ADD_KEY: tr("添加 SSH 公钥"),
      TERMINAL_REMOVE_KEY: tr("删除 SSH 公钥"),
      TERMINAL_REVOKE: tr("撤销 SSH 使用权"),
      TERMINAL_MIGRATE: tr("迁移机器账户"),
      TERMINAL_RESET_PASSWORD: tr("重设机器账户密码"),
      TERMINAL_DELETE_ACCOUNT: tr("删除机器账户"),
      MACHINE_UPDATE: tr("修改机器资料"),
      MACHINE_ANNOUNCEMENT_UPDATE: tr("修改机器公告"),
      MACHINE_ADMIN_ASSIGN: tr("授权机器管理员"),
      MACHINE_ADMIN_REMOVE: tr("移除机器管理员"),
      MACHINE_ACCESS_REQUEST_CREATE: tr("申请机器使用权"),
      MACHINE_ACCESS_REQUEST_WITHDRAW: tr("撤回机器使用权申请"),
      MACHINE_ACCESS_REQUEST_APPROVE: tr("通过机器使用权申请"),
      MACHINE_ACCESS_REQUEST_REJECT: tr("拒绝机器使用权申请"),
      MACHINE_MEMBER_INVITE: tr("邀请用户加入机器"),
      MACHINE_MEMBER_REMOVE: tr("移除机器用户"),
      RESOURCE_GROUP_CREATE: tr("创建资源组"),
      RESOURCE_GROUP_UPDATE: tr("修改资源组"),
      RESOURCE_GROUP_DISABLE_LONG_TERM: tr("停用资源组"),
      RESOURCE_GROUP_ENABLE: tr("重新启用资源组"),
      RESOURCE_GROUP_DELETE: tr("永久删除资源组"),
      RESOURCE_POOL_DELETE: tr("永久删除资源项"),
      MACHINE_DISABLE_LONG_TERM: tr("停用机器"),
      MACHINE_ENABLE: tr("重新启用机器"),
      MACHINE_DELETE: tr("永久删除机器"),
      UNAVAILABILITY_CREATE: tr("创建维护安排"),
      UNAVAILABILITY_CANCEL: tr("取消维护安排"),
      UNAVAILABILITY_INTERRUPT_DISABLE: tr("因停用中止维护"),
      UNAVAILABILITY_CANCEL_DISABLE: tr("因停用取消维护"),
      RESOURCE_DISABLE_WINDOW_CREATE: tr("创建停用记录"),
      RESOURCE_DISABLE_WINDOW_END: tr("结束停用记录"),
      RESERVATION_ADJUST_UNAVAILABILITY: tr("因维护调整占用"),
      RESERVATION_SPLIT_UNAVAILABILITY: tr("因维护拆分占用"),
      RESERVATION_REPLACE: tr("替换资源占用"),
      FEEDBACK_CREATE: tr("提交反馈"),
      FEEDBACK_UPDATE: tr("修改反馈"),
      FEEDBACK_WITHDRAW: tr("撤回反馈"),
      FEEDBACK_ADMIN_COMMENT: tr("管理员回复反馈"),
      FEEDBACK_USER_COMMENT: tr("用户回复反馈"),
      FEEDBACK_STATUS_CHANGE: tr("更改反馈状态"),
      FEEDBACK_LEVEL_CHANGE: tr("更改反馈级别"),
      RESERVATION_CREATE: tr("登记资源占用"),
      RESERVATION_UPDATE: tr("修改占用时间"),
      RESERVATION_CANCEL: tr("取消资源占用"),
      RESERVATION_END_EARLY: tr("提前结束占用"),
      RESERVATION_WITHDRAW_FIRST_MINUTE: tr("撤销刚开始的占用"),
      SETTINGS_UPDATE: tr("修改占用规则"),
      SITE_PROFILE_UPDATE: tr("修改站点信息"),
      SITE_ORIGIN_UPDATE: tr("修改站点地址"),
      ICP_FILING_UPDATE: tr("修改ICP备案号"),
      PUBLIC_SECURITY_FILING_UPDATE: tr("修改公安备案号"),
      EMAIL_DOMAIN_ALLOWLIST_UPDATE: tr("修改注册邮箱白名单"),
      REGISTRATION_EMAIL_POLICY_UPDATE: tr("修改注册邮箱规则"),
      SMTP_SETTINGS_UPDATE: tr("修改邮件配置"),
      SMTP_SETTINGS_ENABLE: tr("启用邮件发送"),
      SMTP_SETTINGS_DISABLE: tr("停用邮件发送"),
      SMTP_PASSWORD_CLEAR: tr("清除邮件登录密码"),
      SMTP_SETTINGS_TEST: tr("测试邮件配置"),
      API_TOKEN_CREATE: tr("创建个人访问令牌"),
      API_TOKEN_REVOKE: tr("吊销个人访问令牌"),
      API_TOKEN_REVOKE_ALL: tr("吊销全部个人访问令牌"),
      SYSTEM_MAINTENANCE_UPDATE: tr("更新系统维护提示"),
      ANNOUNCEMENT_CREATE: tr("创建系统公告"),
      ANNOUNCEMENT_UPDATE: tr("编辑系统公告"),
      ANNOUNCEMENT_REACTIVATE: tr("重新启用系统公告"),
      ANNOUNCEMENT_WITHDRAW: tr("撤下系统公告")
    } as Record<string, string>
  )[action] ?? action;
}
