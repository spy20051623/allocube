import { useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { resolveAnnouncementLink } from "./shared/announcements";

export function AnnouncementMarkdown({
  markdown,
  onInternalNavigate,
  interactive = true
}: {
  markdown: string;
  onInternalNavigate?: (href: string) => void;
  interactive?: boolean;
}) {
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        const link = resolveAnnouncementLink(href);
        if (!link) return <span>{children}</span>;
        if (link.kind === "internal") {
          return (
            <a
              href={link.href}
              onClick={(event) => {
                event.preventDefault();
                if (interactive) onInternalNavigate?.(link.href);
              }}
            >
              {children}
            </a>
          );
        }
        return (
          <a
            href={link.href}
            target={interactive ? "_blank" : undefined}
            rel={interactive ? "noreferrer" : undefined}
            onClick={interactive ? undefined : (event) => event.preventDefault()}
          >
            {children}
          </a>
        );
      },
      img: () => null,
      h1: ({ children }) => <AnnouncementSubheading>{children}</AnnouncementSubheading>,
      h2: ({ children }) => <AnnouncementSubheading>{children}</AnnouncementSubheading>,
      h3: ({ children }) => <AnnouncementSubheading>{children}</AnnouncementSubheading>
    }),
    [interactive, onInternalNavigate]
  );

  return (
    <div className="announcement-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => url}
        components={components}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

function AnnouncementSubheading({ children }: { children: ReactNode }) {
  return <strong className="announcement-subheading">{children}</strong>;
}
