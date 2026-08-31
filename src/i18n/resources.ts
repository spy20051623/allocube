import adminEn from "./resources/en/admin.json";
import authEn from "./resources/en/auth.json";
import calendarEn from "./resources/en/calendar.json";
import commonEn from "./resources/en/common.json";
import docsEn from "./resources/en/docs.json";
import emailEn from "./resources/en/email.json";
import feedbackEn from "./resources/en/feedback.json";
import notificationsEn from "./resources/en/notifications.json";
import validationEn from "./resources/en/validation.json";
import adminZh from "./resources/zh-CN/admin.json";
import authZh from "./resources/zh-CN/auth.json";
import calendarZh from "./resources/zh-CN/calendar.json";
import commonZh from "./resources/zh-CN/common.json";
import docsZh from "./resources/zh-CN/docs.json";
import emailZh from "./resources/zh-CN/email.json";
import feedbackZh from "./resources/zh-CN/feedback.json";
import notificationsZh from "./resources/zh-CN/notifications.json";
import validationZh from "./resources/zh-CN/validation.json";

export const translationDomains = [
  "common",
  "auth",
  "calendar",
  "admin",
  "feedback",
  "validation",
  "notifications",
  "email",
  "docs"
] as const;

export type TranslationDomain = (typeof translationDomains)[number];
type DomainResource = Record<string, string>;
export type LocaleResources = Record<TranslationDomain, DomainResource>;

export const chineseResources = {
  common: commonZh,
  auth: authZh,
  calendar: calendarZh,
  admin: adminZh,
  feedback: feedbackZh,
  validation: validationZh,
  notifications: notificationsZh,
  email: emailZh,
  docs: docsZh
} satisfies LocaleResources;

export const englishResources = {
  common: commonEn,
  auth: authEn,
  calendar: calendarEn,
  admin: adminEn,
  feedback: feedbackEn,
  validation: validationEn,
  notifications: notificationsEn,
  email: emailEn,
  docs: docsEn
} satisfies LocaleResources;

type ResourceTranslationKey =
  | keyof typeof commonZh
  | keyof typeof authZh
  | keyof typeof calendarZh
  | keyof typeof adminZh
  | keyof typeof feedbackZh
  | keyof typeof validationZh
  | keyof typeof notificationsZh
  | keyof typeof emailZh
  | keyof typeof docsZh;

type PluralTranslationKey = ResourceTranslationKey extends infer Key
  ? Key extends `${infer Base}_${"one" | "other"}`
    ? Base
    : never
  : never;

export type TranslationKey = ResourceTranslationKey | PluralTranslationKey;

export function flattenResources(resources: LocaleResources) {
  return Object.assign({}, ...translationDomains.map((domain) => resources[domain])) as Record<
    string,
    string
  >;
}
