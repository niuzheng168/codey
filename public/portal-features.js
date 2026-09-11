// Temporarily disabled in the shipped Portal; retain the history implementation.
export const SESSION_HISTORY_ENABLED = false;
// Keep legacy transports available to compatibility clients, not in the Portal UI.
export const LEGACY_NODE_CONNECTIONS_ENABLED = false;
export const PORTAL_CONNECTION_MODE = "devtunnel";
export const PORTAL_VIEWS = Object.freeze([
  "usage",
  ...(SESSION_HISTORY_ENABLED ? ["sessions"] : []),
  "workspace",
]);

export function resolvePortalView(requested, enabledViews = PORTAL_VIEWS) {
  return enabledViews.includes(requested) ? requested : "usage";
}
