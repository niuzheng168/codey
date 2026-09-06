const button = document.querySelector("#portal-logout");
const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("codey-auth") : null;
const login = () => window.location.replace("/portal-auth/login");
let currentUserId;

async function checkSession() {
  try {
    const response = await fetch("/portal-auth/session", { cache: "no-store", credentials: "same-origin" });
    if (response.status === 401) { login(); return; }
    // Older local/basic-auth portals do not expose this endpoint.
    if (!response.ok) return;
    const result = await response.json();
    if (currentUserId && result.userId && currentUserId !== result.userId) {
      window.location.reload();
      return;
    }
    currentUserId = result.userId;
    if (result.authenticated && button) button.hidden = false;
    const account = document.querySelector("#portal-account-name");
    if (account) { account.textContent = result.username || ""; account.title = result.username || ""; }
    const settings = document.querySelector("#portal-settings");
    if (settings) settings.hidden = !result.multiUser;
  } catch { /* Network outages do not grant access; the server still fails closed. */ }
}

button?.addEventListener("click", async () => {
  button.disabled = true;
  try {
    const response = await fetch("/portal-auth/logout", { method: "POST", credentials: "same-origin" });
    if (!response.ok && response.status !== 401) throw new Error("退出失败");
    channel?.postMessage("logout");
    login();
  } catch {
    button.disabled = false;
    button.textContent = "退出失败，请重试";
  }
});
if (channel) channel.onmessage = (event) => {
  if (event.data === "logout") login();
  else if (event.data === "account-changed") window.location.reload();
};
window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.reload(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void checkSession(); });
setInterval(() => { if (document.visibilityState === "visible") void checkSession(); }, 60000);
void checkSession();
