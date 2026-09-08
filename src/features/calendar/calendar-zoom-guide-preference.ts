const STORAGE_KEY = "allocube.calendar-zoom-guide.v1";
let dismissedForPage = false;

export function readZoomGuideDismissed(): boolean {
  if (dismissedForPage) return true;
  try {
    return localStorage.getItem(STORAGE_KEY) === "dismissed";
  } catch {
    return false;
  }
}

export function saveZoomGuideDismissed() {
  dismissedForPage = true;
  try {
    localStorage.setItem(STORAGE_KEY, "dismissed");
  } catch {
    // Keep dismissal for this page when browser storage is unavailable.
  }
}
