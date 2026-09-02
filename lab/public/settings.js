(() => {
  "use strict";
  const $ = selector => document.querySelector(selector);
  let sessionUser = null;
  let toastTimer = 0;
  const formatBytes = bytes => {
    if (bytes == null) return "Unlimited";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = Number(bytes) || 0, index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
    return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
  };
  const escapeHtml = value => String(value).replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
  const quotaFromGb = value => value === "" ? null : Math.round(Number(value) * 1024 ** 3);
  const quotaToGb = value => value == null ? "" : (value / 1024 ** 3).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");

  async function request(url, options = {}) {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) { location.replace("/login"); throw new Error("Please sign in"); }
    if (!response.ok) throw new Error(payload.error || "Request failed");
    return payload;
  }
  function notify(message) {
    clearTimeout(toastTimer); $("#toast").textContent = message; $("#toast").hidden = false;
    toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 3500);
  }
  function confirmRemoval(username) {
    return new Promise(resolve => {
      $("#confirmMessage").textContent = `This permanently removes “${username}” and all of that account's photos, edits, exports, profiles and LUTs.`;
      $("#confirmOverlay").hidden = false;
      const finish = value => { $("#confirmOverlay").hidden = true; $("#confirmCancel").onclick = null; $("#confirmRemove").onclick = null; resolve(value); };
      $("#confirmCancel").onclick = () => finish(false); $("#confirmRemove").onclick = () => finish(true);
    });
  }

  async function loadUsers() {
    const result = await request("/api/admin/users");
    $("#userList").innerHTML = result.users.map(user => `
      <article class="userCard" data-id="${user.id}">
        <div class="userHeading"><div><strong>${escapeHtml(user.username)}</strong><span>${user.isAdmin ? "Administrator" : user.mustChangePassword ? "Temporary password" : "Member"}</span></div><span>${formatBytes(user.usedBytes)} used</span></div>
        ${user.isAdmin ? '<p class="settingsHelp">The administrator account has unlimited storage.</p>' : `<div class="userFields"><label>Username<input class="editUsername" value="${escapeHtml(user.username)}"></label><label>Storage in GB <small>Blank is unlimited</small><input class="editQuota" type="number" min="0.05" step="0.1" value="${quotaToGb(user.quotaBytes)}"></label><label>New temporary password <small>Optional</small><input class="editPassword" type="password" minlength="8"></label></div><div class="userActions"><button class="saveUser" type="button">Save</button><button class="removeUser danger" type="button">Remove</button></div>`}
      </article>`).join("");
  }

  $("#accountForm").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const result = await request("/api/account", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: $("#accountUsername").value.trim(), currentPassword: $("#accountCurrentPassword").value, newPassword: $("#accountNewPassword").value }) });
      sessionUser = result.user; $("#accountCurrentPassword").value = ""; $("#accountNewPassword").value = ""; notify("Account updated"); if (sessionUser.isAdmin) await loadUsers();
    } catch (error) { notify(error.message); }
  });
  $("#newUserForm").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      await request("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: $("#newUsername").value.trim(), password: $("#newUserPassword").value, quotaBytes: quotaFromGb($("#newUserQuota").value) }) });
      event.target.reset(); await loadUsers(); notify("Account created");
    } catch (error) { notify(error.message); }
  });
  $("#userList").addEventListener("click", async event => {
    const card = event.target.closest(".userCard"); if (!card) return;
    const username = card.querySelector(".editUsername")?.value.trim();
    try {
      if (event.target.closest(".saveUser")) {
        await request(`/api/admin/users/${card.dataset.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, quotaBytes: quotaFromGb(card.querySelector(".editQuota").value), password: card.querySelector(".editPassword").value }) });
        await loadUsers(); notify("Account updated");
      } else if (event.target.closest(".removeUser") && await confirmRemoval(username)) {
        await request(`/api/admin/users/${card.dataset.id}`, { method: "DELETE" }); await loadUsers(); notify("Account and its library were removed");
      }
    } catch (error) { notify(error.message); }
  });
  $("#logoutButton").onclick = async () => { await request("/api/auth/logout", { method: "POST" }).catch(() => {}); location.replace("/login"); };

  request("/api/auth/session").then(async result => {
    if (!result.authenticated) return location.replace("/login");
    sessionUser = result.user; $("#accountUsername").value = sessionUser.username;
    if (sessionUser.isAdmin) { $("#adminSection").hidden = false; await loadUsers(); }
  }).catch(error => notify(error.message));
})();
