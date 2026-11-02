/* eslint-disable */
// dsh-autostart — browser half.
//
// One row in Settings → General: "开机自启动 / Start with Windows", with the official
// switch. The row owns its copy, its value and its write path (the slot owner passes
// no props); the value itself lives in the Host half, persisted next to the profile,
// and the Host keeps the Windows login item in sync with it.
window.__ModuleLoader__.load({
  id: 'dsh-autostart',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    var STATE = '/plugins/dsh-autostart/state';
    var CONFIG = '/plugins/dsh-autostart/config';
    var PLUGIN_ID = 'dsh-autostart';

    // ── language ─────────────────────────────────────────────────────────────
    function normalizeLang(tag) {
      var s = String(tag || '').toLowerCase();
      if (s.indexOf('zh') === 0) return 'zh';
      if (s.indexOf('en') === 0) return 'en';
      return null;
    }
    function pickLang(doc, nav) {
      var declared = '';
      try {
        declared = (doc && doc.documentElement && doc.documentElement.getAttribute('lang')) || '';
      } catch (e) { void e; }
      var hit = normalizeLang(declared);
      if (hit) return hit;
      var tags = [];
      try {
        if (nav && nav.languages && nav.languages.length) tags = [].slice.call(nav.languages);
        else if (nav && nav.language) tags = [nav.language];
      } catch (e) { void e; }
      for (var i = 0; i < tags.length; i += 1) {
        var found = normalizeLang(tags[i]);
        if (found) return found;
      }
      return 'en';
    }
    var LANG = pickLang(typeof document === 'undefined' ? null : document,
      typeof navigator === 'undefined' ? null : navigator);
    var langSubs = [];
    function notifyLang() {
      langSubs.forEach(function (fn) { try { fn(); } catch (e) { void e; } });
    }
    function setLang(id) {
      var next = normalizeLang(id);
      if (!next || next === LANG) return;
      LANG = next;
      notifyLang();
    }
    // The locale service can arrive after this plugin, so both paths are wired.
    function attachLocale(locale) {
      if (!locale) return;
      function read() {
        try {
          var snapshot = typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : null;
          return snapshot && snapshot.active ? snapshot.active : null;
        } catch (e) { void e; return null; }
      }
      setLang(read());
      try {
        if (typeof locale.subscribe === 'function') locale.subscribe(function () { setLang(read()); });
      } catch (e) { void e; }
    }

    var STRINGS = {
      zh: {
        label: '开机自启动',
        hintOn: '登录 Windows 后自动启动 DeepSeek Harness。',
        hintOff: '已关闭：登录 Windows 后不会自动启动。',
        hintBusy: '正在写入…',
        hintUnsupported: '仅 Windows 桌面版支持。',
        hintMissing: '找不到可执行文件，开关暂不可用。',
        failed: '保存失败：{reason}',
        readFailed: '读取状态失败：{reason}',
      },
      en: {
        label: 'Start with Windows',
        hintOn: 'Starts DeepSeek Harness automatically when you sign in to Windows.',
        hintOff: 'Off: DeepSeek Harness does not start when you sign in.',
        hintBusy: 'Saving…',
        hintUnsupported: 'Only the Windows desktop app supports this.',
        hintMissing: 'The executable was not found, so the switch is unavailable.',
        failed: 'Could not save: {reason}',
        readFailed: 'Could not read the state: {reason}',
      },
    };
    function t(key, params) {
      var table = STRINGS[LANG] || STRINGS.en;
      var text = table[key] !== undefined ? table[key] : (STRINGS.en[key] !== undefined ? STRINGS.en[key] : key);
      if (!params) return text;
      return String(text).replace(/\{(\w+)\}/g, function (all, name) {
        return params[name] === undefined ? all : String(params[name]);
      });
    }

    // ── styles (official primitives CSS, .dsa- prefix, --dsw-* tokens only) ──
    var CSS = [
      '.dsa-row{display:flex;align-items:center;gap:12px;padding:12px 0;width:100%}',
      '.dsa-text{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}',
      '.dsa-label{font-size:13px;line-height:1.5;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dsa-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dsa-error{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}',
      '.dsa-switch{width:36px;height:20px;padding:2px;border-radius:999px;border:none;background:var(--dsw-alias-border-l3);cursor:pointer;display:inline-flex;align-items:center;flex-shrink:0;box-sizing:border-box}',
      '.dsa-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}',
      '.dsa-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dsa-switch:disabled{opacity:.4;cursor:not-allowed}',
      '.dsa-thumb{width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb);transition:transform 120ms ease;display:block}',
      '.dsa-switch[aria-checked="true"] .dsa-thumb{background:var(--dsw-alias-label-primary-foreground);transform:translateX(16px)}',
    ].join('\n');
    function ensureStyles() {
      if (typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin-css="dsh-autostart/client.css"]') !== null) return;
      var tag = document.createElement('style');
      tag.dataset.plugin = PLUGIN_ID;
      tag.dataset.pluginCss = 'dsh-autostart/client.css';
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── shared live state (one row, one source of truth) ─────────────────────
    var live = {
      loading: true,
      supported: true,
      enabled: true,
      active: false,
      executable: '',
      executableExists: true,
      error: '',
    };
    function adopt(payload) {
      if (!payload || payload.ok !== true) return;
      if (payload.platform !== undefined) live.supported = payload.platform === 'win32';
      if (payload.config && typeof payload.config.enabled === 'boolean') live.enabled = payload.config.enabled;
      if (typeof payload.active === 'boolean') live.active = payload.active;
      if (typeof payload.executable === 'string') live.executable = payload.executable;
      if (typeof payload.executableExists === 'boolean') live.executableExists = payload.executableExists;
      live.loading = false;
    }

    function reasonOf(status, body) {
      if (body && typeof body.reason === 'string' && body.reason) return body.reason;
      if (body && typeof body.detail === 'string' && body.detail) return body.detail;
      return 'HTTP ' + status;
    }

    function DsaSwitch(props) {
      return React.createElement('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        className: 'dsa-switch',
        disabled: props.disabled,
        onClick: function () { if (!props.disabled) props.onChange(!props.checked); },
      }, React.createElement('span', { className: 'dsa-thumb' }));
    }

    function SettingsGeneralRow() {
      var state = React.useState({ tick: 0, busy: false });
      var setState = state[1];
      function rerender() {
        setState(function (prev) { return { tick: prev.tick + 1, busy: prev.busy }; });
      }
      function setBusy(busy) {
        setState(function (prev) { return { tick: prev.tick, busy: busy }; });
      }
      React.useEffect(function () {
        langSubs.push(rerender);
        return function () {
          var index = langSubs.indexOf(rerender);
          if (index >= 0) langSubs.splice(index, 1);
        };
      }, []);

      var busy = state[0].busy;
      var unavailable = !live.supported || !live.executableExists;
      var disabled = busy || live.loading || unavailable;

      function hint() {
        if (!live.supported) return t('hintUnsupported');
        if (!live.executableExists) return t('hintMissing');
        if (live.loading) return t('hintBusy');
        if (busy) return t('hintBusy');
        return live.enabled ? t('hintOn') : t('hintOff');
      }

      function toggle(next) {
        if (busy) return;
        var previous = live.enabled;
        live.enabled = next;
        live.error = '';
        setBusy(true);
        rerender();
        fetch(CONFIG, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: next }),
        }).then(function (response) {
          return response.json().then(function (body) { return { status: response.status, body: body }; },
            function () { return { status: response.status, body: null }; });
        }).then(function (result) {
          if (!result.body || result.body.ok !== true) {
            throw new Error(reasonOf(result.status, result.body));
          }
          live.enabled = next;
          adopt(result.body);
        }).catch(function (error) {
          live.enabled = previous;
          live.error = t('failed', { reason: String((error && error.message) || error) });
        }).then(function () {
          setBusy(false);
          rerender();
        });
      }

      return React.createElement('div', { className: 'dsa-row' },
        React.createElement('div', { className: 'dsa-text' },
          React.createElement('div', { className: 'dsa-label' }, t('label')),
          React.createElement('div', { className: 'dsa-hint' }, hint()),
          live.error ? React.createElement('div', { className: 'dsa-error', role: 'alert' }, live.error) : null),
        DsaSwitch({ checked: live.enabled, disabled: disabled, label: t('label'), onChange: toggle }));
    }

    // ── mounting ─────────────────────────────────────────────────────────────
    function mount(ctx) {
      var slots = ctx && typeof ctx.get === 'function' ? ctx.get('slots') : null;
      if (!slots || typeof slots.inject !== 'function') return;
      ensureStyles();
      var dispose = slots.inject('settings.general.item', function () {
        return slots.register({ name: 'settings.general.item', id: PLUGIN_ID, order: 95 }, SettingsGeneralRow);
      });
      try {
        if (typeof ctx.effect === 'function') {
          ctx.effect(function () {
            return function () { try { dispose(); } catch (e) { void e; } };
          });
        }
      } catch (e) { void e; }
    }

    exports.name = PLUGIN_ID;
    exports.inject = ['slots'];
    exports.apply = function (ctx) {
      try {
        if (ctx && typeof ctx.get === 'function') attachLocale(ctx.get('locale'));
      } catch (e) { void e; }
      try {
        if (ctx && typeof ctx.inject === 'function') {
          ctx.inject(['locale'], function (sub) {
            var service = null;
            try { service = (sub && sub.locale) || (sub && typeof sub.get === 'function' ? sub.get('locale') : null); } catch (e) { void e; }
            attachLocale(service);
          });
        }
      } catch (e) { void e; }
      try {
        if (ctx && typeof ctx.on === 'function') {
          ctx.on('internal/service', function (name) {
            if (name !== 'locale') return;
            try { attachLocale(ctx.get('locale')); } catch (e) { void e; }
          });
        }
      } catch (e) { void e; }

      // Only mount where the Host half can actually manage a login item.
      fetch(STATE, { credentials: 'same-origin' })
        .then(function (response) { return response.ok ? response.json() : null; })
        .then(function (body) {
          if (!body || body.ok !== true) return;
          if (body.platform !== undefined && body.platform !== 'win32') return;
          adopt(body);
          mount(ctx);
        })
        .catch(function () { /* probe failed → no row, zero side effects */ });
    };

    return module.exports;
  },
});
