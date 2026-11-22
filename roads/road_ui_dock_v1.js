/* SRP Map tools dock V2 — places Navigator and Admin Road Editor inside the top header. */
(function () {
  'use strict';

  function install() {
    var existing = document.getElementById('srp-map-tools-dock');
    if (existing) return true;

    var topbar = document.getElementById('atlas-topbar') || document.querySelector('.atlas-topbar');
    var account = document.getElementById('atlas-account') || (topbar && topbar.querySelector('.atlas-account'));
    var nav = document.querySelector('.winterhold-navigator-control');
    var admin = document.querySelector('.road-admin-control');
    if (!topbar || !account || !nav || !admin) return false;

    var style = document.createElement('style');
    style.id = 'srp-map-tools-dock-v2-style';
    style.textContent = `
      /* Header launcher: occupies the free space between archive status and user account. */
      #atlas-topbar.atlas-has-tools-dock { gap: 14px; }
      #atlas-topbar .srp-map-tools-dock {
        position: static; z-index: auto; display: flex; flex: 0 0 auto;
        align-items: center; justify-content: center; gap: 7px;
        margin: 0 0 0 auto; padding: 0;
        border: 0; border-radius: 0; background: transparent; box-shadow: none;
        -webkit-backdrop-filter: none; backdrop-filter: none;
        font-family: Georgia,'Times New Roman',serif;
      }
      #atlas-topbar .srp-map-tools-dock button {
        display: inline-flex; align-items: center; justify-content: center; gap: 7px;
        min-height: 34px; padding: 6px 12px; box-sizing: border-box;
        border: 1px solid rgba(199,169,113,.48); border-radius: 7px;
        color: #eadfc9;
        background: linear-gradient(180deg,rgba(87,103,107,.48),rgba(28,43,51,.72));
        box-shadow: inset 0 1px rgba(255,255,255,.08), 0 2px 5px rgba(0,0,0,.16);
        cursor: pointer; white-space: nowrap;
        font: 700 10px Georgia,'Times New Roman',serif; letter-spacing: .035em;
        transition: background .16s,border-color .16s,box-shadow .16s,transform .16s;
      }
      #atlas-topbar .srp-map-tools-dock button:hover {
        border-color: rgba(229,196,132,.9);
        background: linear-gradient(180deg,rgba(143,117,72,.62),rgba(58,57,43,.84));
        box-shadow: inset 0 1px rgba(255,255,255,.12),0 0 10px rgba(210,174,105,.12);
      }
      #atlas-topbar .srp-map-tools-dock button:active { transform: translateY(1px); }
      #atlas-topbar .srp-map-tools-dock button[aria-expanded="true"] {
        color: #1c2528; border-color: #e5c47f;
        background: linear-gradient(180deg,#f0d69c,#c9a45e);
        box-shadow: 0 2px 8px rgba(0,0,0,.25),inset 0 1px rgba(255,255,255,.45);
      }
      #atlas-topbar .srp-map-tools-dock button:focus-visible {
        outline: 2px solid #f0d69c; outline-offset: 2px;
      }
      #atlas-topbar .srp-map-tools-dock .srp-tool-icon { font-size: 15px; line-height: 1; }
      #atlas-topbar .srp-map-tools-dock [hidden] { display: none !important; }
      #atlas-topbar.atlas-has-tools-dock .atlas-account { margin-left: 10px !important; }

      /* Panels open below the 66px desktop header, never under the account block. */
      .leaflet-top.leaflet-right {
        top: 108px !important; right: 14px !important; left: auto !important;
        z-index: 1900 !important;
      }
      .winterhold-navigator-control {
        display: none; width: 276px !important; max-width: calc(100vw - 28px) !important;
        max-height: calc(100vh - 126px) !important; overflow-y: auto !important;
        margin: 0 0 8px 0 !important;
      }
      .road-admin-control {
        display: none !important; position: fixed !important;
        top: 108px !important; right: 14px !important; left: auto !important; bottom: auto !important;
        z-index: 1910 !important; width: 292px !important;
        max-width: calc(100vw - 28px) !important; max-height: calc(100vh - 126px) !important;
      }
      .road-admin-control .road-admin-card { max-height: calc(100vh - 126px) !important; }
      .road-admin-control .road-admin-body {
        max-height: calc(100vh - 196px) !important; overflow-y: auto !important;
        overscroll-behavior: contain !important;
      }

      @media(max-width:700px) {
        #atlas-topbar.atlas-has-tools-dock { gap: 6px !important; }
        #atlas-topbar .srp-map-tools-dock { gap: 4px; margin-left: auto; }
        #atlas-topbar .srp-map-tools-dock button {
          width: 36px; min-width: 36px; min-height: 34px; padding: 5px 6px !important;
          gap: 0; font-size: 0 !important;
        }
        #atlas-topbar .srp-map-tools-dock .srp-tool-label { display: none; }
        #atlas-topbar .srp-map-tools-dock .srp-tool-icon { font-size: 17px; }
        #atlas-topbar.atlas-has-tools-dock .atlas-account { margin-left: 2px !important; }
        #atlas-topbar .atlas-brand { flex: 0 1 auto !important; max-width: 42vw; }
        #atlas-topbar .atlas-brand-title { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
        .leaflet-top.leaflet-right { top: 104px !important; right: 8px !important; }
        .winterhold-navigator-control { width: 260px !important; max-width: calc(100vw - 16px) !important; max-height: calc(100vh - 118px) !important; }
        .road-admin-control { top: 104px !important; right: 8px !important; width: 280px !important; max-width: calc(100vw - 16px) !important; max-height: calc(100vh - 118px) !important; }
        .road-admin-control .road-admin-body { max-height: calc(100vh - 180px) !important; }
      }
      @media(max-width:430px) {
        #atlas-topbar .srp-map-tools-dock button { width: 32px; min-width: 32px; min-height: 32px; }
        #atlas-topbar .srp-map-tools-dock .srp-tool-icon { font-size: 15px; }
        #atlas-topbar .atlas-brand { max-width: 38vw; }
        #atlas-topbar.atlas-has-tools-dock .atlas-account-copy { max-width: 72px; }
        #atlas-topbar.atlas-has-tools-dock .atlas-account-name { max-width: 72px; }
      }
    `;
    document.head.appendChild(style);

    var dock = document.createElement('nav');
    dock.id = 'srp-map-tools-dock';
    dock.className = 'srp-map-tools-dock';
    dock.setAttribute('aria-label', 'Инструменты карты');
    dock.innerHTML = `
      <button type="button" id="srp-open-navigator" aria-expanded="false" aria-label="Навигатор" title="Навигатор">
        <span class="srp-tool-icon" aria-hidden="true">⌖</span><span class="srp-tool-label">Навигатор</span>
      </button>
      <button type="button" id="srp-open-road-editor" aria-expanded="false" aria-label="Редактор дорог" title="Редактор дорог" hidden>
        <span class="srp-tool-icon" aria-hidden="true">⚒</span><span class="srp-tool-label">Редактор дорог</span>
      </button>`;

    // Place launchers directly in the header, immediately before the account block.
    topbar.insertBefore(dock, account);
    topbar.classList.add('atlas-has-tools-dock');

    var navButton = dock.querySelector('#srp-open-navigator');
    var adminButton = dock.querySelector('#srp-open-road-editor');
    var activePanel = null;

    function isAdmin() {
      return document.body.classList.contains('is-admin');
    }

    function adminIsEditing() {
      return admin.classList.contains('is-drawing') || admin.classList.contains('is-node-mode');
    }

    function setButtonState(button, isOpen) {
      button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }

    function closePanels() {
      nav.style.display = 'none';
      admin.style.setProperty('display', 'none', 'important');
      activePanel = null;
      setButtonState(navButton, false);
      setButtonState(adminButton, false);
    }

    function warnEditorLock() {
      var status = admin.querySelector('#road-admin-status');
      if (status) {
        status.textContent = 'Сначала завершите или отмените создание дороги/узла.';
        status.classList.add('is-warning');
      }
    }

    function openPanel(which) {
      if (which === 'admin' && !isAdmin()) return;
      if (activePanel === which) {
        if (which === 'admin' && adminIsEditing()) { warnEditorLock(); return; }
        closePanels();
        return;
      }
      if (activePanel === 'admin' && adminIsEditing()) {
        warnEditorLock();
        return;
      }

      closePanels();
      activePanel = which;
      if (which === 'nav') {
        nav.style.display = 'block';
        setButtonState(navButton, true);
      } else {
        admin.classList.remove('is-collapsed');
        admin.style.setProperty('display', 'block', 'important');
        setButtonState(adminButton, true);
      }
    }

    navButton.addEventListener('click', function () { openPanel('nav'); });
    adminButton.addEventListener('click', function () { openPanel('admin'); });
    dock.addEventListener('click', function (event) { event.stopPropagation(); });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && activePanel && !(activePanel === 'admin' && adminIsEditing())) closePanels();
    });

    function syncRole() {
      var allowed = isAdmin();
      adminButton.hidden = !allowed;
      if (!allowed && activePanel === 'admin') closePanels();
      if (!allowed) admin.style.setProperty('display', 'none', 'important');
    }
    var roleObserver = new MutationObserver(syncRole);
    roleObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    syncRole();

    var collapse = admin.querySelector('#road-admin-collapse');
    if (collapse) collapse.setAttribute('title', 'Свернуть или развернуть инструменты');

    window.SrpMapToolsDock = {
      openNavigator: function () { openPanel('nav'); },
      openRoadEditor: function () { openPanel('admin'); },
      close: closePanels,
      get activePanel() { return activePanel; }
    };
    return true;
  }

  if (!install()) {
    var observer = new MutationObserver(function () {
      if (install()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('load', function () { install(); }, { once: true });
  }
})();
