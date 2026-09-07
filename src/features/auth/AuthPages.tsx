import { useEffect } from "react";
import { resolveAuthLocation } from "../../auth-routing";
import type { DashboardBootstrap } from "../../shared/types";
import { type AuthHistoryState, type AuthNavigate } from "./types";
import { RegisterPage } from "./RegisterPage";
import { ForgotPasswordPage } from "./ForgotPasswordPage";
import { ResetPasswordPage } from "./ResetPasswordPage";
import { LoginPage } from "./LoginPage";

export function AuthRouter({
  location,
  historyState,
  navigate,
  onAuthenticated,
  notify,
  consumeAuthFlash
}: {
  location: ReturnType<typeof resolveAuthLocation>;
  historyState: AuthHistoryState;
  navigate: AuthNavigate;
  onAuthenticated: (bootstrap: DashboardBootstrap) => Promise<void>;
  notify: (kind: "success" | "error", message: string) => void;
  consumeAuthFlash: () => void;
}) {
  const flash = location.path === "/login" ? historyState.authFlash ?? null : null;
  useEffect(() => {
    if (flash) consumeAuthFlash();
  }, [consumeAuthFlash, flash]);

  if (location.path === "/register") {
    return (
      <RegisterPage
        navigate={navigate}
        notify={notify}
        successUsername={historyState.registrationSuccess?.username ?? ""}
      />
    );
  }
  if (location.path === "/forgot-password") {
    return <ForgotPasswordPage navigate={navigate} />;
  }
  if (location.path === "/reset-password") {
    return (
      <ResetPasswordPage
        navigate={navigate}
        token={location.resetToken}
      />
    );
  }
  return (
    <LoginPage
      navigate={navigate}
      onAuthenticated={onAuthenticated}
      initialIdentifier={flash?.username ?? ""}
      initialMessage={flash?.message ?? ""}
    />
  );
}
