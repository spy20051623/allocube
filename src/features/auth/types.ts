import { type AuthPath } from "../../auth-routing";

type AuthFlash = {
  message: string;
  username?: string;
};

export type AuthHistoryState = {
  authFlash?: AuthFlash;
  registrationSuccess?: {
    username: string;
  };
};

export type AuthNavigate = (
  path: AuthPath,
  state?: AuthHistoryState | null,
  replace?: boolean
) => void;
