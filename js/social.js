// =====================================================
// GoldAI Pro — Social links row (Mobile-First patch, NEW file)
// =====================================================
// Pure UI. Reads window.GoldAI_Config.SOCIAL_LINKS only. Renders a disabled
// (greyed, non-clickable) icon for any link left empty, instead of guessing
// a URL. Fill the real URLs into js/config.js's SOCIAL_LINKS when known.

(function () {
  const ICONS = {
    telegram: "✈️",
    x: "𝕏",
    instagram: "📷",
    eitaa: "🟠",
    rubika: "🟣",
  };
  const LABELS = {
    telegram: "Telegram",
    x: "X / Twitter",
    instagram: "Instagram",
    eitaa: "Eitaa",
    rubika: "Rubika",
  };

  function render() {
    const row = document.getElementById("socialRow");
    if (!row) return;
    const links = (window.GoldAI_Config && window.GoldAI_Config.SOCIAL_LINKS) || {};
    row.innerHTML = "";
    Object.keys(LABELS).forEach(key => {
      const url = (links[key] || "").trim();
      const hasUrl = url && url !== "#";
      const el = document.createElement(hasUrl ? "a" : "button");
      el.className = "social-btn" + (hasUrl ? "" : " social-disabled");
      el.title = LABELS[key] + (hasUrl ? "" : " — لینک هنوز تنظیم نشده");
      el.setAttribute("aria-label", LABELS[key]);
      el.textContent = ICONS[key] || "•";
      if (hasUrl) {
        el.href = url;
        el.target = "_blank";
        el.rel = "noopener noreferrer";
      } else {
        el.type = "button";
        el.disabled = true;
      }
      row.appendChild(el);
    });
  }

  document.addEventListener("DOMContentLoaded", render);
})();
