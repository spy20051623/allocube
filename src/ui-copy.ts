const unknownStatus = "状态未知";

export function userStatusLabel(status: string) {
  return (
    {
      PENDING_APPROVAL: "等待审核",
      CHANGES_REQUESTED: "需要修改",
      ACTIVE: "已启用",
      DISABLED: "已停用"
    } as Record<string, string>
  )[status] ?? unknownStatus;
}

export function resourceGroupStatusLabel(status: string) {
  return (
    {
      ACTIVE: "启用",
      DISABLED: "停用"
    } as Record<string, string>
  )[status] ?? unknownStatus;
}

export function reservationStatusLabel(
  status: string,
  startAt: string,
  endAt: string,
  now: number
) {
  if (status === "CANCELLED") return "已取消";
  if (status === "CANCELLED_UNAVAILABILITY") return "因维护取消";
  if (status !== "CONFIRMED") return unknownStatus;
  if (new Date(endAt).getTime() <= now) return "已结束";
  if (new Date(startAt).getTime() <= now) return "进行中";
  return "未开始";
}

export function auditActionLabel(action: string) {
  return (
    {
      USER_REGISTER: "提交注册申请",
      USER_LOGIN: "用户登录",
      USER_STATUS_CHANGE: "更改用户状态",
      USER_DELETE: "永久删除用户",
      USER_APPROVE: "通过注册申请",
      USER_RETURN: "要求修改注册信息",
      USER_REJECT: "拒绝注册",
      USERNAME_CHANGE: "修改用户名",
      EMAIL_CHANGE: "修改邮箱",
      PROFILE_CHANGE_REQUEST: "提交资料修改",
      PROFILE_CHANGE_WITHDRAW: "撤回资料修改",
      PROFILE_CHANGE_APPROVE: "通过资料修改",
      PROFILE_CHANGE_REJECT: "拒绝资料修改",
      MACHINE_CREATE: "创建机器",
      MACHINE_UPDATE: "修改机器资料",
      MACHINE_ADMIN_ASSIGN: "授权机器管理员",
      MACHINE_ADMIN_REMOVE: "移除机器管理员",
      MACHINE_ACCESS_REQUEST_CREATE: "申请机器使用权",
      MACHINE_ACCESS_REQUEST_WITHDRAW: "撤回机器使用权申请",
      MACHINE_ACCESS_REQUEST_APPROVE: "通过机器使用权申请",
      MACHINE_ACCESS_REQUEST_REJECT: "拒绝机器使用权申请",
      MACHINE_MEMBER_INVITE: "邀请用户加入机器",
      MACHINE_MEMBER_REMOVE: "移除机器用户",
      RESOURCE_GROUP_CREATE: "创建资源组",
      RESOURCE_GROUP_UPDATE: "修改资源组",
      RESOURCE_GROUP_DISABLE_LONG_TERM: "停用资源组",
      RESOURCE_GROUP_ENABLE: "重新启用资源组",
      RESOURCE_GROUP_DELETE: "永久删除资源组",
      RESOURCE_POOL_DELETE: "永久删除资源项",
      MACHINE_DISABLE_LONG_TERM: "停用机器",
      MACHINE_ENABLE: "重新启用机器",
      MACHINE_DELETE: "永久删除机器",
      UNAVAILABILITY_CREATE: "创建维护安排",
      UNAVAILABILITY_CANCEL: "取消维护安排",
      UNAVAILABILITY_INTERRUPT_DISABLE: "因停用中止维护",
      UNAVAILABILITY_CANCEL_DISABLE: "因停用取消维护",
      RESOURCE_DISABLE_WINDOW_CREATE: "创建停用记录",
      RESOURCE_DISABLE_WINDOW_END: "结束停用记录",
      RESERVATION_ADJUST_UNAVAILABILITY: "因维护调整占用",
      RESERVATION_SPLIT_UNAVAILABILITY: "因维护拆分占用",
      RESERVATION_CREATE: "登记资源占用",
      RESERVATION_UPDATE: "修改占用时间",
      RESERVATION_CANCEL: "取消资源占用",
      RESERVATION_END_EARLY: "提前结束占用",
      RESERVATION_WITHDRAW_FIRST_MINUTE: "撤销刚开始的占用",
      SETTINGS_UPDATE: "修改占用规则",
      SITE_ORIGIN_UPDATE: "修改站点地址",
      EMAIL_DOMAIN_ALLOWLIST_UPDATE: "修改注册邮箱白名单",
      REGISTRATION_EMAIL_POLICY_UPDATE: "修改注册邮箱规则",
      SMTP_SETTINGS_UPDATE: "修改邮件配置",
      SMTP_SETTINGS_ENABLE: "启用邮件发送",
      SMTP_SETTINGS_DISABLE: "停用邮件发送",
      SMTP_PASSWORD_CLEAR: "清除邮件登录密码",
      SMTP_SETTINGS_TEST: "测试邮件配置",
      API_TOKEN_CREATE: "创建个人访问令牌",
      API_TOKEN_REVOKE: "吊销个人访问令牌",
      API_TOKEN_REVOKE_ALL: "吊销全部个人访问令牌"
    } as Record<string, string>
  )[action] ?? "其他系统操作";
}
