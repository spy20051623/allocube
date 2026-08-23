export const FEEDBACK_TYPES = ["ISSUE", "REQUIREMENT"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export const FEEDBACK_LEVELS = [
  "SUGGESTION",
  "NOT_URGENT",
  "NORMAL",
  "SERIOUS",
  "URGENT",
  "FATAL",
  "VERY_URGENT"
] as const;
export type FeedbackLevel = (typeof FEEDBACK_LEVELS)[number];

export const FEEDBACK_STATUSES = [
  "SUBMITTED",
  "CONFIRMED",
  "ADOPTED",
  "FIXED",
  "IMPLEMENTED",
  "REJECTED",
  "WITHDRAWN"
] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const FEEDBACK_TERMINAL_STATUSES = [
  "FIXED",
  "IMPLEMENTED",
  "REJECTED",
  "WITHDRAWN"
] as const satisfies readonly FeedbackStatus[];

export const ISSUE_LEVELS = ["SUGGESTION", "NORMAL", "SERIOUS", "FATAL"] as const;
export const REQUIREMENT_LEVELS = [
  "NOT_URGENT",
  "NORMAL",
  "URGENT",
  "VERY_URGENT"
] as const;
export const ISSUE_STATUSES = [
  "SUBMITTED",
  "CONFIRMED",
  "FIXED",
  "REJECTED",
  "WITHDRAWN"
] as const;
export const REQUIREMENT_STATUSES = [
  "SUBMITTED",
  "ADOPTED",
  "IMPLEMENTED",
  "REJECTED",
  "WITHDRAWN"
] as const;

export const feedbackTypeLabels: Record<FeedbackType, string> = {
  ISSUE: "问题单",
  REQUIREMENT: "需求单"
};

export const feedbackLevelLabels: Record<FeedbackLevel, string> = {
  SUGGESTION: "建议",
  NOT_URGENT: "不紧急",
  NORMAL: "一般",
  SERIOUS: "严重",
  URGENT: "紧急",
  FATAL: "致命",
  VERY_URGENT: "非常紧急"
};

export const feedbackStatusLabels: Record<FeedbackStatus, string> = {
  SUBMITTED: "已提交",
  CONFIRMED: "已确认",
  ADOPTED: "已采纳",
  FIXED: "已修复",
  IMPLEMENTED: "已实现",
  REJECTED: "已拒绝",
  WITHDRAWN: "已撤回"
};

export const feedbackTemplates: Record<FeedbackType, string> = {
  ISSUE: `## 问题描述\n\n\n## 复现步骤\n\n1. \n\n## 预期结果\n\n\n## 实际结果\n\n\n## 补充信息\n`,
  REQUIREMENT: `## 使用场景\n\n\n## 需求描述\n\n\n## 预期效果\n\n\n## 补充信息\n`
};

export function feedbackLevelsFor(type: FeedbackType): readonly FeedbackLevel[] {
  return type === "ISSUE" ? ISSUE_LEVELS : REQUIREMENT_LEVELS;
}

export function feedbackStatusesFor(type: FeedbackType): readonly FeedbackStatus[] {
  return type === "ISSUE" ? ISSUE_STATUSES : REQUIREMENT_STATUSES;
}

export function isFeedbackLevelValid(type: FeedbackType, level: FeedbackLevel) {
  return feedbackLevelsFor(type).includes(level);
}

export function isFeedbackStatusValid(type: FeedbackType, status: FeedbackStatus) {
  return feedbackStatusesFor(type).includes(status);
}

export function isFeedbackTerminal(status: FeedbackStatus) {
  return (FEEDBACK_TERMINAL_STATUSES as readonly FeedbackStatus[]).includes(status);
}

export function isFeedbackCommentable(status: FeedbackStatus) {
  return status !== "WITHDRAWN";
}

export function formatFeedbackNumber(number: number) {
  return `FB-${String(number).padStart(6, "0")}`;
}

export interface FeedbackAttachment {
  id: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
  contentUrl: string;
  createdAt: string;
}

export interface FeedbackActivity {
  id: string;
  kind: "CREATED" | "CONTENT_UPDATED" | "STATUS_CHANGED" | "LEVEL_CHANGED" | "COMMENT" | "WITHDRAWN";
  actorName: string;
  bodyMarkdown: string;
  fromStatus: FeedbackStatus | null;
  toStatus: FeedbackStatus | null;
  fromLevel: FeedbackLevel | null;
  toLevel: FeedbackLevel | null;
  changedFields: string[];
  attachments: FeedbackAttachment[];
  createdAt: string;
}

export interface FeedbackTicketSummary {
  id: string;
  number: number;
  displayNumber: string;
  type: FeedbackType;
  level: FeedbackLevel;
  status: FeedbackStatus;
  title: string;
  submittedByName: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface FeedbackTicketDetail extends FeedbackTicketSummary {
  bodyMarkdown: string;
  attachments: FeedbackAttachment[];
  activities: FeedbackActivity[];
  canEdit: boolean;
  canWithdraw: boolean;
  canComment: boolean;
}
