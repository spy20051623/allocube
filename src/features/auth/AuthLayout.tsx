import { tr } from "../../i18n/index";
import { DisplayPreferences } from "../../components/DisplayPreferences";
import { Boxes, BookOpenText } from "lucide-react";
import { useState, useEffect } from "react";
import { api } from "../../api";
import { publicSecurityFilingUrl } from "../../shared/public-security-filing";
import { type PublicSiteConfigPayload } from "../../shared/settings";

export function AuthLayout({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [siteConfig, setSiteConfig] = useState<PublicSiteConfigPayload | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    void api<PublicSiteConfigPayload>("/auth/site-config")
      .then((value) => {
        if (active) setSiteConfig(value);
      })
      .catch(() => {
        if (active) setSiteConfig(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const publicSecurityFilingHref = publicSecurityFilingUrl(
    siteConfig?.publicSecurityFilingNumber ?? "",
  );

  return (
    <div className="auth-page">
      <section className="auth-story">
        <div className="brand-lockup auth-brand">
          <div className="brand-icon">
            <Boxes size={23} />
          </div>
          <span>Allocube</span>
        </div>
        <div className="auth-intro">
          <h1>{tr("计算资源占用系统")}</h1>
          <p>
            {tr(
              "统一安排机器、设备与共享资源的占用时间，减少多人协作中的冲突。",
            )}
          </p>
        </div>
        {(siteConfig?.icpFilingNumber ||
          (siteConfig?.publicSecurityFilingNumber &&
            publicSecurityFilingHref)) && (
          <div className="auth-filings">
            {siteConfig?.icpFilingNumber && (
              <a
                className="auth-icp-link"
                href="http://beian.miit.gov.cn/"
                target="_blank"
                rel="noreferrer"
              >
                {siteConfig.icpFilingNumber}
              </a>
            )}
            {siteConfig?.publicSecurityFilingNumber &&
              publicSecurityFilingHref && (
                <a
                  className="auth-public-security-link"
                  href={publicSecurityFilingHref}
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    src="/public-security-filing.png"
                    alt=""
                    width={20}
                    height={20}
                  />
                  {siteConfig.publicSecurityFilingNumber}
                </a>
              )}
          </div>
        )}
      </section>
      <AuthPanel title={title}>{children}</AuthPanel>
    </div>
  );
}

export function AuthPanel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="auth-panel">
      <div className="auth-panel-content">
        <div className="auth-page-tools">
          <a className="auth-docs-link" href="/docs/getting-started">
            <BookOpenText size={15} />
            {tr("帮助与文档")}
          </a>
          <DisplayPreferences />
        </div>
        <div className="auth-card">
          <div className="auth-card-head">
            <span className="mini-mark">
              <Boxes size={18} />
            </span>
            <h2>{title}</h2>
          </div>
          {children}
        </div>
      </div>
    </section>
  );
}
