(() => {
  "use strict";
  const loginForm = document.querySelector("#loginForm");
  const changeForm = document.querySelector("#changeForm");
  const errorBox = document.querySelector("#authError");

  async function request(url, options = {}) {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Server Lab could not complete that request");
    return payload;
  }

  function showError(message = "") {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }

  function showPasswordChange(user, currentPassword = "") {
    loginForm.hidden = true;
    changeForm.hidden = false;
    document.querySelector("#changeUsername").value = user.username;
    document.querySelector("#currentPassword").value = currentPassword;
    document.querySelector("#newPassword").focus();
  }

  loginForm.addEventListener("submit", async event => {
    event.preventDefault();
    showError();
    const button = loginForm.querySelector("button");
    button.disabled = true;
    try {
      const username = document.querySelector("#username").value.trim();
      const password = document.querySelector("#password").value;
      const result = await request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
      if (result.user.mustChangePassword) showPasswordChange(result.user, password);
      else location.replace("/");
    } catch (error) { showError(error.message); }
    finally { button.disabled = false; }
  });

  changeForm.addEventListener("submit", async event => {
    event.preventDefault();
    showError();
    const newPassword = document.querySelector("#newPassword").value;
    if (newPassword !== document.querySelector("#confirmPassword").value) return showError("New passwords do not match");
    const button = changeForm.querySelector("button");
    button.disabled = true;
    try {
      await request("/api/account", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: document.querySelector("#changeUsername").value.trim(), currentPassword: document.querySelector("#currentPassword").value, newPassword })
      });
      location.replace("/");
    } catch (error) { showError(error.message); }
    finally { button.disabled = false; }
  });

  request("/api/auth/session").then(result => {
    if (!result.authenticated) return;
    if (result.user.mustChangePassword) showPasswordChange(result.user);
    else location.replace("/");
  }).catch(() => {});
})();
