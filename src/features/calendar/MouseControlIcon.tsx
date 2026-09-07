

function MouseControlIcon({
  highlight,
  size = 14
}: {
  highlight: "LEFT_BUTTON" | "RIGHT_BUTTON" | "WHEEL";
  size?: number;
}) {
  return (
    <svg
      className="mouse-control-icon"
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path
        className="mouse-control-base"
        d="M5 10V9a7 7 0 0 1 14 0v1Z"
        stroke="none"
      />
      {(highlight === "LEFT_BUTTON" || highlight === "RIGHT_BUTTON") && (
        <path
          className="mouse-control-accent"
          d={
            highlight === "LEFT_BUTTON"
              ? "M5 10V9a7 7 0 0 1 7-7v8Z"
              : "M12 2a7 7 0 0 1 7 7v1h-7Z"
          }
          stroke="none"
        />
      )}
      <path d="M5 10h14" />
      {highlight === "LEFT_BUTTON" || highlight === "RIGHT_BUTTON" ? (
        <path d="M12 2v8" />
      ) : (
        <rect
          className="mouse-control-accent"
          x="9.25"
          y="2.5"
          width="5.5"
          height="8.5"
          rx="2.75"
          stroke="none"
        />
      )}
      <path
        d="M5 9a7 7 0 0 1 14 0v5a7 7 0 0 1-14 0Z"
        fill="none"
      />
    </svg>
  );
}

export function MouseLeftButtonIcon({ size = 14 }: { size?: number }) {
  return <MouseControlIcon highlight="LEFT_BUTTON" size={size} />;
}

export function MouseRightButtonIcon({ size = 14 }: { size?: number }) {
  return <MouseControlIcon highlight="RIGHT_BUTTON" size={size} />;
}

export function MouseWheelIcon({ size = 14 }: { size?: number }) {
  return <MouseControlIcon highlight="WHEEL" size={size} />;
}
