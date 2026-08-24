export type RealtimeEventName = "revision" | "announcement" | "feedback";
export type RealtimeConnectionState =
  | "CONNECTING"
  | "CONNECTED"
  | "DISCONNECTED";

type RealtimeListener = () => void;
type ConnectionListener = (state: RealtimeConnectionState) => void;

const eventNames: RealtimeEventName[] = [
  "revision",
  "announcement",
  "feedback"
];
const eventListeners = new Map<
  RealtimeEventName,
  Set<RealtimeListener>
>(eventNames.map((eventName) => [eventName, new Set()]));
const connectionListeners = new Set<ConnectionListener>();

let source: EventSource | null = null;
let subscriptionCount = 0;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let connectionState: RealtimeConnectionState = "CONNECTING";

function publishConnectionState(nextState: RealtimeConnectionState) {
  if (connectionState === nextState) return;
  connectionState = nextState;
  for (const listener of connectionListeners) listener(nextState);
}

function publishEvent(eventName: RealtimeEventName) {
  for (const listener of eventListeners.get(eventName) ?? []) listener();
}

function ensureSource() {
  if (closeTimer !== null) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  if (source) return;

  publishConnectionState("CONNECTING");
  try {
    const nextSource = new EventSource("/api/v1/events");
    source = nextSource;
    nextSource.onopen = () => publishConnectionState("CONNECTED");
    nextSource.onerror = () => publishConnectionState("DISCONNECTED");
    for (const eventName of eventNames) {
      nextSource.addEventListener(eventName, () => publishEvent(eventName));
    }
  } catch {
    source = null;
    publishConnectionState("DISCONNECTED");
  }
}

function addSubscription() {
  subscriptionCount += 1;
  ensureSource();
}

function removeSubscription() {
  subscriptionCount = Math.max(0, subscriptionCount - 1);
  if (subscriptionCount > 0 || closeTimer !== null) return;
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (subscriptionCount > 0) return;
    source?.close();
    source = null;
    connectionState = "CONNECTING";
  }, 0);
}

export function subscribeRealtimeEvent(
  eventName: RealtimeEventName,
  listener: RealtimeListener
) {
  const listeners = eventListeners.get(eventName)!;
  listeners.add(listener);
  addSubscription();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    listeners.delete(listener);
    removeSubscription();
  };
}

export function subscribeRealtimeConnection(
  listener: ConnectionListener
) {
  connectionListeners.add(listener);
  listener(connectionState);
  addSubscription();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    connectionListeners.delete(listener);
    removeSubscription();
  };
}
