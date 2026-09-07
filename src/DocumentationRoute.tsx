import { useEffect, useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { tr } from "./i18n";
import { withRequestDeadline } from "./request-deadline";

type Page = typeof import("./DocumentationPage").DocumentationPage;
let loadedPage: Page | null = null;

/** Keep the manual, its styles and API reference out of ordinary application routes. */
export function DocumentationRoute(props: ComponentProps<Page>) {
  useTranslation();
  const [Page, setPage] = useState<Page | null>(() => loadedPage);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (loadedPage) return;
    const controller = new AbortController();
    void withRequestDeadline(() => import("./DocumentationPage"), controller.signal)
      .then(module => {
        if (controller.signal.aborted) return;
        loadedPage = module.DocumentationPage;
        setPage(() => module.DocumentationPage);
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, []);

  if (Page) return <Page {...props} />;
  return (
    <main className="boot-shell">
      <div className="boot-mark">A</div>
      <h1>Allocube</h1>
      <p role={failed ? "alert" : "status"}>{failed ? tr("文档加载失败，请重试") : tr("正在载入")}</p>
      {failed && <button className="secondary-button" onClick={() => window.location.reload()}>{tr("重试")}</button>}
    </main>
  );
}
