import i18next, { type TOptions } from "i18next";
import { initReactI18next } from "react-i18next";
import serverEnglish from "./server-en.json";
import { createSystemMessageCatalog } from "../shared/system-message";
import {
  chineseResources,
  englishResources,
  translationDomains,
  type TranslationKey
} from "./resources";

const systemMessages = createSystemMessageCatalog(serverEnglish);

const notificationEnglish: Record<string, string> = {
  "notification.ACCOUNT_STATUS.title": "Account status updated",
  "notification.USER_APPROVAL.title": "Review required",
  "notification.REGISTRATION_SUBMITTED.title": "Registration submitted",
  "notification.USERNAME_CHANGED.title": "Username updated",
  "notification.PROFILE_CHANGE_REVIEW.title": "Profile review",
  "notification.PROFILE_CHANGE_SUBMITTED.title": "Profile update submitted",
  "notification.PROFILE_CHANGE_APPROVED.title": "Profile update approved",
  "notification.PROFILE_CHANGE_REJECTED.title": "Profile update rejected",
  "notification.MACHINE_ACCESS_REQUEST.title": "Access request",
  "notification.MACHINE_ACCESS_GRANTED.title": "Machine access granted",
  "notification.MACHINE_ACCESS_REJECTED.title": "Machine access denied",
  "notification.MACHINE_ACCESS_REMOVED.title": "Machine access removed",
  "notification.MACHINE_ROLE_CHANGED.title": "Machine role updated",
  "notification.RESOURCE_UNAVAILABILITY.title": "Resource availability changed",
  "notification.RESERVATION_CANCELLED.title": "Reservation cancelled",
  "notification.RESERVATION_RELEASED_BY_MANAGER.title": "Reservation ended",
  "notification.RESOURCE_GROUP_CHANGED.title": "Resource group updated",
  "notification.RESOURCE_GROUP_DELETED.title": "Resource group deleted",
  "notification.MACHINE_DELETED.title": "Machine deleted",
  "notification.AVAILABILITY_WATCH.title": "Resource available",
  "notification.FEEDBACK_CREATED.title": "New feedback",
  "notification.FEEDBACK_UPDATED.title": "Feedback updated",
  "notification.FEEDBACK_WITHDRAWN.title": "Feedback withdrawn",
  "notification.FEEDBACK_ADMIN_COMMENT.title": "Administrator replied",
  "notification.FEEDBACK_USER_COMMENT.title": "New feedback comment",
  "notification.FEEDBACK_STATUS_CHANGED.title": "Feedback status updated",
  "notification.FEEDBACK_LEVEL_CHANGED.title": "Feedback level updated",
  "notification.generic.title": "Allocube notification",
  "notification.generic.body": "Something changed in Allocube. Open it to view the details."
};

const notificationChinese = Object.fromEntries(
  Object.keys(notificationEnglish).map((key) => [key, key])
);

export const supportedLocales = ["zh-CN", "en"] as const;
export type AppLocale = (typeof supportedLocales)[number];

export const LOCALE_STORAGE_KEY = "allocube:locale:v1";

const metadata = {
  "zh-CN": {
    description: "机器、设备与共享资源的占用协调系统",
    docsTitle: "文档中心 · Allocube"
  },
  en: {
    description: "Reservation coordination for machines, devices, and shared resources",
    docsTitle: "Documentation · Allocube"
  }
} as const;

export function normalizeLocale(value: string | null | undefined): AppLocale | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
  return null;
}

export function resolveInitialLocale(
  storedLocale?: string | null,
  browserLocales?: readonly string[]
): AppLocale {
  const stored = normalizeLocale(storedLocale);
  if (stored) return stored;
  for (const value of browserLocales ?? []) {
    const locale = normalizeLocale(value);
    if (locale) return locale;
  }
  return "zh-CN";
}

function browserInitialLocale() {
  if (typeof window === "undefined") return "zh-CN" as const;
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    // Private browsing and locked-down environments may reject storage access.
  }
  return resolveInitialLocale(stored, navigator.languages);
}

export function currentLocale(): AppLocale {
  return normalizeLocale(i18next.resolvedLanguage ?? i18next.language) ?? "zh-CN";
}

export function updateDocumentLocale(locale: AppLocale) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
  const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (description) description.content = metadata[locale].description;
}

export async function initializeI18n() {
  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init({
      lng: browserInitialLocale(),
      fallbackLng: "zh-CN",
      supportedLngs: [...supportedLocales],
      load: "currentOnly",
      keySeparator: false,
      nsSeparator: false,
      ns: [...translationDomains],
      defaultNS: "common",
      fallbackNS: translationDomains.filter((domain) => domain !== "common"),
      interpolation: { escapeValue: false },
      resources: {
        "zh-CN": {
          ...chineseResources,
          notifications: { ...chineseResources.notifications, ...notificationChinese }
        },
        en: {
          ...englishResources,
          notifications: { ...englishResources.notifications, ...notificationEnglish }
        }
      },
      react: { useSuspense: false }
    });
  }
  updateDocumentLocale(currentLocale());
  return i18next;
}

export async function changeLocale(locale: AppLocale) {
  await i18next.changeLanguage(locale);
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // The active page still changes language when persistence is unavailable.
  }
  updateDocumentLocale(locale);
}

export function localizedDocsTitle(locale = currentLocale()) {
  return metadata[locale].docsTitle;
}

function translate(key: string, options?: TOptions): string {
  if (!i18next.isInitialized) {
    const values = (options ?? {}) as Record<string, unknown>;
    return key.replace(/\{\{([^}]+)\}\}/g, (_match, name: string) =>
      values[name] === undefined ? `{{${name}}}` : String(values[name])
    );
  }
  return i18next.t(key, options) as string;
}

export function tr(key: TranslationKey, options?: TOptions): string {
  return translate(key, options);
}

export function trDynamic(key: string, options?: TOptions): string {
  return translate(key, options);
}

export function translateServerMessage(message: string) {
  if (currentLocale() !== "en") return message;
  const resolved = systemMessages.resolve(message);
  return resolved ? systemMessages.translate(resolved.code, resolved.params) ?? message : message;
}

export function translateSystemMessageCode(
  code: string,
  params: Record<string, unknown> = {}
) {
  if (currentLocale() !== "en") return null;
  return systemMessages.translate(code, params);
}

export default i18next;
