

export type SystemAnnouncement = {
  id: string;
  title: string;
  bodyMarkdown: string;
  status: "ACTIVE" | "WITHDRAWN";
  version: number;
  createdByName: string;
  createdAt: string;
  publishedAt: string;
  updatedAt: string;
  withdrawnAt: string | null;
};

export type AnnouncementEditorState =
  | { mode: "CREATE" }
  | {
    mode: "EDIT" | "REACTIVATE";
    announcement: SystemAnnouncement;
  };
