(() => {
  "use strict";
  const key = "ondevice-film-lab-theme";
  const normalize = value => value === "blue" ? "blue" : "black";
  function apply(value) {
    const theme = normalize(value);
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "black" ? "#000000" : "#111827");
    document.querySelectorAll("[data-theme-select]").forEach(select => { select.value = theme; });
  }
  let saved;
  try { saved = localStorage.getItem(key); } catch { /* Default still works with storage disabled. */ }
  apply(saved);
  document.addEventListener("DOMContentLoaded", () => {
    apply(document.documentElement.dataset.theme);
    document.querySelectorAll("[data-theme-select]").forEach(select => select.addEventListener("change", () => {
      apply(select.value);
      try { localStorage.setItem(key, normalize(select.value)); } catch { /* Keep this session's choice. */ }
    }));
  });
  window.addEventListener("storage", event => { if (event.key === key || event.key === null) apply(event.newValue); });
})();
