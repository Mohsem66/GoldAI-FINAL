// =====================================
// GoldAI — API Token status UI (auth-token-ui.js)
// =====================================
// PURPOSE (token-flow fix only):
//   The backend fail-closes (HTTP 401) every write to /mt5/system-state and
//   /mt5/trading-state unless the request carries the SAME token as the
//   server's GOLD_AI_API_TOKEN (see backend/lib/auth-token.js). Nothing in
//   the dashboard ever gave the user a way to actually set that token in
//   the browser, so SYSTEM ON/OFF and AUTO TRADE SIGNAL looked "broken".
//
//   This file does NOT change any MT5 / signal / risk / worker / execution
//   logic. It only:
//     1) lets the user paste their own GOLD_AI_API_TOKEN once, storing it
//        exactly where js/app.js's existing apiAuthHeaders() already reads
//        it from (localStorage 'goldai_api_token') — so no other file's
//        auth logic needs to change;
//     2) shows a clear, visible banner whenever a write comes back 401,
//        instead of the previous silent console.warn/console.error.
//
//   The real secret token is never hardcoded here or anywhere else in this
//   patch — it is only ever entered by the person operating the dashboard,
//   into their own browser's localStorage.
//
// USAGE FROM js/app.js (already wired in this patch):
//   window.GoldAIAuthUI.reportUnauthorized('system' | 'trading')
//   window.GoldAIAuthUI.reportOk()
// =====================================
(function () {
  'use strict';

  var STORAGE_KEY = 'goldai_api_token';
  var banner = null;
  var modalOverlay = null;

  var CONTEXT_MESSAGES = {
    system: 'توکن API معتبر نیست یا تنظیم نشده — روشن/خاموش کردن SYSTEM ذخیره نشد.',
    trading: 'توکن API معتبر نیست یا تنظیم نشده — تغییر حالت MANUAL/AUTO یا AUTO TRADE SIGNAL ذخیره نشد.',
    generic: 'توکن API معتبر نیست یا تنظیم نشده.'
  };

  function ensureStyles() {
    if (document.getElementById('goldaiAuthUiStyles')) return;
    var style = document.createElement('style');
    style.id = 'goldaiAuthUiStyles';
    style.textContent = [
      '#goldaiAuthBanner{position:fixed;left:0;right:0;top:0;z-index:99999;',
      'display:none;align-items:center;gap:10px;flex-wrap:wrap;',
      'background:#3a1414;color:#ffd9d9;border-bottom:1px solid #7a2323;',
      'padding:10px 14px;font-family:inherit;font-size:13px;direction:rtl;',
      'box-shadow:0 2px 8px rgba(0,0,0,.35)}',
      '#goldaiAuthBanner.show{display:flex}',
      '#goldaiAuthBanner .gai-msg{flex:1 1 auto;line-height:1.6}',
      '#goldaiAuthBanner button{cursor:pointer;border:none;border-radius:6px;',
      'padding:6px 12px;font-size:12px;font-weight:600}',
      '#goldaiAuthBanner .gai-set-btn{background:#ffd9d9;color:#3a1414}',
      '#goldaiAuthBanner .gai-close-btn{background:transparent;color:#ffd9d9;',
      'border:1px solid #7a2323}',
      '#goldaiAuthModalOverlay{position:fixed;inset:0;z-index:100000;',
      'display:none;align-items:center;justify-content:center;',
      'background:rgba(0,0,0,.55)}',
      '#goldaiAuthModalOverlay.show{display:flex}',
      '#goldaiAuthModal{direction:rtl;background:#181822;color:#eee;',
      'border:1px solid #333;border-radius:12px;padding:20px;width:90%;',
      'max-width:380px;font-family:inherit}',
      '#goldaiAuthModal h3{margin:0 0 8px;font-size:15px}',
      '#goldaiAuthModal p{margin:0 0 12px;font-size:12.5px;color:#b7b7c2;line-height:1.7}',
      '#goldaiAuthModal input{width:100%;box-sizing:border-box;padding:9px 10px;',
      'border-radius:8px;border:1px solid #3a3a4a;background:#0f0f16;color:#eee;',
      'font-size:13px;margin-bottom:12px}',
      '#goldaiAuthModal .gai-modal-actions{display:flex;gap:8px;justify-content:flex-end}',
      '#goldaiAuthModal .gai-save-btn{background:#3ddc84;color:#0b2016;border:none;',
      'border-radius:6px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer}',
      '#goldaiAuthModal .gai-cancel-btn{background:transparent;color:#b7b7c2;',
      'border:1px solid #3a3a4a;border-radius:6px;padding:8px 16px;font-size:13px;',
      'cursor:pointer}',
      '#goldaiAuthModal .gai-status{font-size:12px;margin-top:-6px;margin-bottom:10px;',
      'min-height:16px}',
      '#goldaiAuthModal .gai-status.ok{color:#3ddc84}',
      '#goldaiAuthModal .gai-status.err{color:#ff8a8a}'
    ].join('');
    document.head.appendChild(style);
  }

  function buildBanner() {
    if (banner) return banner;
    banner = document.createElement('div');
    banner.id = 'goldaiAuthBanner';
    banner.innerHTML =
      '<span class="gai-msg" id="goldaiAuthMsg"></span>' +
      '<button type="button" class="gai-set-btn" id="goldaiAuthSetBtn">تنظیم توکن API</button>' +
      '<button type="button" class="gai-close-btn" id="goldaiAuthCloseBtn">بستن</button>';
    document.body.appendChild(banner);
    banner.querySelector('#goldaiAuthSetBtn').addEventListener('click', openModal);
    banner.querySelector('#goldaiAuthCloseBtn').addEventListener('click', hideBanner);
    return banner;
  }

  function showBanner(message) {
    ensureStyles();
    buildBanner();
    banner.querySelector('#goldaiAuthMsg').textContent = message;
    banner.classList.add('show');
  }

  function hideBanner() {
    if (banner) banner.classList.remove('show');
  }

  function buildModal() {
    if (modalOverlay) return modalOverlay;
    modalOverlay = document.createElement('div');
    modalOverlay.id = 'goldaiAuthModalOverlay';
    modalOverlay.innerHTML =
      '<div id="goldaiAuthModal" role="dialog" aria-modal="true">' +
      '  <h3>تنظیم توکن API GoldAI</h3>' +
      '  <p>همان مقداری را وارد کنید که در فایل <code>backend/.env</code> روی سرور، ' +
      '  جلوی <code>GOLD_AI_API_TOKEN</code> نوشته شده است. این مقدار فقط داخل مرورگر خودتان ' +
      '  ذخیره می‌شود (localStorage) و به هیچ سرور دیگری ارسال نمی‌شود.</p>' +
      '  <input type="password" id="goldaiAuthTokenInput" autocomplete="off" ' +
      '    placeholder="GOLD_AI_API_TOKEN را اینجا وارد کنید" />' +
      '  <div class="gai-status" id="goldaiAuthModalStatus"></div>' +
      '  <div class="gai-modal-actions">' +
      '    <button type="button" class="gai-cancel-btn" id="goldaiAuthCancelBtn">انصراف</button>' +
      '    <button type="button" class="gai-save-btn" id="goldaiAuthSaveBtn">ذخیره</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(modalOverlay);

    modalOverlay.addEventListener('click', function (e) {
      if (e.target === modalOverlay) closeModal();
    });
    modalOverlay.querySelector('#goldaiAuthCancelBtn').addEventListener('click', closeModal);
    modalOverlay.querySelector('#goldaiAuthSaveBtn').addEventListener('click', saveToken);
    modalOverlay.querySelector('#goldaiAuthTokenInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') saveToken();
      if (e.key === 'Escape') closeModal();
    });
    return modalOverlay;
  }

  function openModal() {
    ensureStyles();
    buildModal();
    var input = modalOverlay.querySelector('#goldaiAuthTokenInput');
    var status = modalOverlay.querySelector('#goldaiAuthModalStatus');
    status.textContent = '';
    status.className = 'gai-status';
    try {
      input.value = localStorage.getItem(STORAGE_KEY) || '';
    } catch (_) { input.value = ''; }
    modalOverlay.classList.add('show');
    setTimeout(function () { input.focus(); }, 30);
  }

  function closeModal() {
    if (modalOverlay) modalOverlay.classList.remove('show');
  }

  function saveToken() {
    var input = modalOverlay.querySelector('#goldaiAuthTokenInput');
    var status = modalOverlay.querySelector('#goldaiAuthModalStatus');
    var value = String(input.value || '').trim();
    if (!value) {
      status.textContent = 'توکن نمی‌تواند خالی باشد.';
      status.className = 'gai-status err';
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch (e) {
      status.textContent = 'ذخیره در مرورگر ناموفق بود: ' + e.message;
      status.className = 'gai-status err';
      return;
    }
    status.textContent = 'ذخیره شد. حالا دوباره روی دکمه SYSTEM یا AUTO بزنید.';
    status.className = 'gai-status ok';
    hideBanner();
    setTimeout(closeModal, 900);
  }

  window.GoldAIAuthUI = {
    reportUnauthorized: function (context) {
      var msg = CONTEXT_MESSAGES[context] || CONTEXT_MESSAGES.generic;
      showBanner(msg);
    },
    reportOk: function () {
      hideBanner();
    },
    openTokenModal: openModal
  };
})();
