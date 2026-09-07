/* Loaded synchronously before the app. This is the single theme state owner. */
(() => {
  if (window.allocubeTheme) return;
  const storageKey = "allocube:theme:v1";
  const normalize = value => value === "light" || value === "dark" ? value : "system";
  let storage = null;
  let preference = "system";
  try {
    storage = window.localStorage;
    preference = normalize(storage.getItem(storageKey));
  } catch { /* A blocked store must not prevent changing the current page. */ }
  let media = null;
  try { media = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null; } catch { /* Default to light. */ }
  const resolve = () => preference === "system" ? (media?.matches ? "dark" : "light") : preference;
  let snapshot = Object.freeze({ preference, resolved: resolve() });
  const listeners = new Set();
  function apply() {
    const resolved = resolve();
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.dataset.themePreference = preference;
    root.style.colorScheme = resolved;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = resolved === "dark" ? "#111318" : "#f5f6f8";
    if (snapshot.preference === preference && snapshot.resolved === resolved) return;
    snapshot = Object.freeze({ preference, resolved });
    for (const listener of listeners) listener();
  }
  window.allocubeTheme = Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setPreference(value) {
      preference = normalize(value);
      apply();
      try { storage?.setItem(storageKey, preference); } catch { /* Keep the in-memory preference. */ }
    }
  });
  apply();
  const onSystemChange = () => { if (preference === "system") apply(); };
  if (media?.addEventListener) media.addEventListener("change", onSystemChange);
  else media?.addListener?.(onSystemChange);
  window.addEventListener("storage", event => {
    if (event.key !== null && event.key !== storageKey) return;
    if (event.storageArea && event.storageArea !== storage) return;
    preference = normalize(event.key === null ? null : event.newValue);
    apply();
  });
})();
