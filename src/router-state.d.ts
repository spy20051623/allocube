import "@tanstack/history";

declare module "@tanstack/history" {
  interface HistoryState {
    authFlash?: {
      message: string;
      username?: string;
    };
    registrationSuccess?: {
      username: string;
    };
  }
}
