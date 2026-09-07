import { tr } from "../i18n/index";
import { X } from "lucide-react";
import { resourceTagDraftIssue } from "../resource-config-validation";

export function TagEditor({
  tags,
  input,
  onChange,
  invalid = false
}: {
  tags: string[];
  input: string;
  onChange: (tags: string[], input: string) => void;
  invalid?: boolean;
}) {
  const addTag = () => {
    const tag = input.trim();
    if (!tag) {
      onChange(tags, "");
      return;
    }
    if (
      resourceTagDraftIssue(tags, tag) !==
      tr("按回车或点击添加当前标签")
    ) {
      return;
    }
    onChange([...tags, tag], "");
  };
  return (
    <div className="resource-tag-editor">
      <div className="resource-tag-entry">
        <div
          className={[
            "resource-tag-input-shell",
            invalid ? "resource-config-invalid" : ""
          ].filter(Boolean).join(" ")}
          aria-invalid={invalid}
        >
          <input
            aria-label={tr("输入标签")}
            value={input}
            onChange={(event) => onChange(tags, event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key !== "Enter" ||
                event.nativeEvent.isComposing
              ) {
                return;
              }
              event.preventDefault();
              addTag();
            }}
          />
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={!input.trim()}
          onClick={addTag}
        >
          {tr("添加")}</button>
      </div>
      {tags.length > 0 && (
        <div className="resource-tag-list">
          {tags.map((tag, index) => (
            <span className="resource-tag-token" key={`${tag}:${index}`}>
              <span>{tag}</span>
              <button
                type="button"
                aria-label={tr("删除标签 {{v0}}", { v0: tag })}
                onClick={() =>
                  onChange(
                    tags.filter(
                      (_, candidateIndex) => candidateIndex !== index
                    ),
                    input
                  )}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
