const form = document.querySelector("#login-form");
const message = document.querySelector("#login-error");
const submit = document.querySelector("#login-submit");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submit.disabled = true;
  message.textContent = "";
  try {
    const response = await fetch("/portal-auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({
        username: form.elements.username.value,
        password: form.elements.password.value,
      }),
    });
    const result = await response.json();
    form.elements.password.value = "";
    if (!response.ok) {
      message.textContent = result.error || "登录失败，请重试";
      return;
    }
    if (typeof BroadcastChannel === "function") {
      const channel = new BroadcastChannel("codey-auth");
      channel.postMessage("account-changed");
      channel.close();
    }
    window.location.replace("/?view=workspace");
  } catch {
    message.textContent = "连接失败，请稍后重试";
  } finally { submit.disabled = false; }
});

// A login page restored from browser history must not retain password input.
window.addEventListener("pageshow", () => { form.elements.password.value = ""; });
