import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnnouncementMarkdown } from "../src/AnnouncementMarkdown.js";

describe("公告 Markdown", () => {
  it("渲染安全链接并忽略 HTML、图片和危险协议", () => {
    const html = renderToStaticMarkup(
      <AnnouncementMarkdown
        markdown={
          "[站内](allocube:/calendar) [外部](https://example.org/help) " +
          "[危险](javascript:alert(1)) ![跟踪图](https://example.org/a.png) " +
          "<script>alert(1)</script>"
        }
        onInternalNavigate={() => undefined}
      />
    );

    expect(html).toContain('href="/calendar"');
    expect(html).toContain('href="https://example.org/help"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
  });
});
