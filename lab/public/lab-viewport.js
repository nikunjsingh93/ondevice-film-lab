// The persistent Lab shell already reserves the system safe areas.
// Run before layout; standalone pages still use their browser-provided insets.
(() => {
  if (window.parent === window) return;
  const root = document.documentElement;
  root.classList.add("labEmbedded");
  for (const side of ["top", "right", "bottom", "left"]) {
    root.style.setProperty(`--lab-safe-area-${side}`, "0px");
  }
})();
