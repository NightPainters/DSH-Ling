// dsh-ling client v4 (browser half) — single-file bundle for __ModuleLoader__.
// Two mount points:
//   1) conversation.session.header.utilities (session scope) — per-session
//      work/life toggle. Occupant receives the standard prop `sessionId`
//      (dsh-client-ui-session SessionStandardProps), so it always targets the
//      session being viewed (no host heuristic).
//   2) sidebar.footer.action (root scope) — global DEFAULT-mode control,
//      visible even on the blank/new-conversation view (D2 follow source).
// Interactions: left-click = toggle; hover 1.5s = menu; contextmenu suppressed.
(function () {
  if (typeof window === 'undefined' || !window.__ModuleLoader__) return;
  window.__ModuleLoader__.load({
    id: 'dsh-ling',
    factory: function (require) {
      var React = null;
      try { React = require('react'); } catch (e) { React = null; }
      var module = { exports: {} };
      var exports = module.exports;

      var API = '/api/dsh-ling';

      // ---------------- 第三人称代词(跟随 persona.pronoun) ----------------
      // 界面文案里写死的「她」全部经 she() 出口 —— 用户改成「他 / TA / 自定义」后文案随之改变;
      // **只用于文案**,绝不用于用户原话或记忆数据(那会把数据改错)。
      var UI_PRONOUN = '她';
      function she(s) { return UI_PRONOUN === '她' ? s : String(s).split('她').join(UI_PRONOUN); }
      function setPronounFrom(persona) {
        var pn = persona && persona.pronoun ? String(persona.pronoun).slice(0, 6) : '';
        if (pn) UI_PRONOUN = pn;
      }
      var NS = 'dsh-ling';
      var STYLE_ID = 'dsh-ling-css';
      var HOVER_MS = 1500;

      function qs(obj) {
        var parts = [];
        for (var k in obj) {
          if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
            parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
          }
        }
        return parts.length ? '?' + parts.join('&') : '';
      }

      function api(path, opts) {
        opts = opts || {};
        return fetch(API + path, {
          method: opts.method || 'GET',
          headers: { 'content-type': 'application/json' },
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        }).then(function (res) { return res.json().catch(function () { return null; }); });
      }

      // ---------------- tiny store ----------------
      function createStore(init) {
        var state = init || {};
        var subs = [];
        return {
          get: function () { return state; },
          set: function (patch) { state = Object.assign({}, state, patch); subs.forEach(function (f) { f(state); }); },
          subscribe: function (f) { subs.push(f); return function () { subs.splice(subs.indexOf(f), 1); }; },
        };
      }

      // ---------------- DOM helpers ----------------
      function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var tag = document.createElement('style');
        tag.id = STYLE_ID;
        tag.dataset.plugin = 'dsh-ling';
        tag.textContent =
          ':root{' +
          '--lg-primary:#4D6BFE;--lg-accent:#4166d5;--lg-deep:#0D28F3;--lg-sky:#4176e6;--lg-cyan:#12B7F5;' +
          '--lg-gold:#e3c25f;--lg-gold-soft:#f2e3ad;' +
          '--lg-bg:#ffffff;--lg-bg2:#f5f8ff;--lg-text:#1e2330;--lg-dim:rgba(30,35,48,.58);' +
          '--lg-border:#d7dff2;--lg-border-soft:#e4e9f8;--lg-input:#b9c6e8;--lg-hover:rgba(77,107,254,.12);' +
          '--lg-ring:rgba(65,102,213,.28);--lg-danger:#e05555;' +
          '--lg-hover-bg:#cfe0ff;--lg-hover-text:#0b2a9e;--lg-btntext:#3d4a75;' +
          '--lg-bgrad:linear-gradient(145deg,#ffffff 0%,#b9c9ff 52%,#d5b257 118%);' +
          '--lg-bgrad-soft:linear-gradient(150deg,#ffffff 0%,rgba(185,201,255,.55) 55%,rgba(213,178,87,.35) 125%);' +
          '--lg-rowbg:linear-gradient(160deg,#fbfdff 0%,#edf2fd 100%);' +
          '--lg-halo:0 16px 44px rgba(64,92,220,.17),0 2px 6px rgba(64,92,220,.08),inset 0 1px 0 0 rgba(255,255,255,.75);' +
          '--lg-halo-menu:0 8px 26px rgba(30,48,110,.2),0 1px 3px rgba(64,92,220,.08),inset 0 1px 0 0 rgba(255,255,255,.65);}' +
          '[data-dark="1"],html[data-ds-theme="dark"],body[data-ds-dark-theme]{' +
          '--lg-primary:#7d93ff;--lg-accent:#5b7ff0;--lg-deep:#8aa2ff;--lg-sky:#6f9bff;--lg-cyan:#38c8ff;' +
          '--lg-gold:#e3c25f;--lg-gold-soft:rgba(227,194,95,.4);' +
          '--lg-bg:#10162b;--lg-bg2:#182142;--lg-text:#dce7ff;--lg-dim:rgba(220,231,255,.58);' +
          '--lg-border:rgba(125,160,255,.38);--lg-border-soft:rgba(125,160,255,.22);--lg-input:rgba(125,147,255,.6);' +
          '--lg-hover:rgba(120,160,255,.2);--lg-ring:rgba(125,160,255,.42);--lg-danger:#ff7b7b;' +
          '--lg-hover-bg:#c7d8ff;--lg-hover-text:#0a1d86;--lg-btntext:#aac4ff;' +
          '--lg-bgrad:linear-gradient(145deg,#a9bdff 0%,#5b7ff0 46%,#c9a54a 120%);' +
          '--lg-bgrad-soft:linear-gradient(150deg,rgba(169,189,255,.55) 0%,rgba(91,127,240,.32) 55%,rgba(201,165,74,.42) 125%);' +
          '--lg-rowbg:linear-gradient(160deg,#1c2549 0%,#131a33 100%);' +
          '--lg-halo:0 16px 46px rgba(0,0,0,.55),0 0 22px rgba(91,127,240,.26),inset 0 1px 0 0 rgba(125,160,255,.3);' +
          '--lg-halo-menu:0 10px 30px rgba(0,0,0,.5),0 0 14px rgba(91,127,240,.18),inset 0 1px 0 0 rgba(125,160,255,.22);}' +
          '.dsh-ling-btn{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;min-height:32px;border:1px solid transparent;' +
          'border-radius:9px;background:transparent;cursor:pointer;font-size:13.5px;color:var(--lg-btntext);white-space:nowrap;transition:all .12s;' +
          'min-width:0;max-width:150px;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;box-sizing:border-box;}' +
          '.dsh-ling-btn:hover{background:var(--lg-hover-bg);color:var(--lg-hover-text);box-shadow:0 0 0 1px var(--lg-ring);}' +
          '.dsh-ling-btn:focus-visible{outline:2px solid var(--lg-accent);outline-offset:1px;}' +
          '.dsh-ling-btn.dim{opacity:.95;font-size:12.5px;max-width:120px;padding:5px 10px;}' +
          '.dsh-ling-btn.rail{padding:0;width:34px;min-width:34px;height:34px;justify-content:center;font-size:16px;border-radius:10px;}' +
          '.dsh-ling-menu{position:fixed;z-index:9999;min-width:230px;max-width:340px;background:linear-gradient(var(--lg-bg),var(--lg-bg)) padding-box,var(--lg-bgrad) border-box;' +
          'border:1px solid transparent;border-radius:13px;box-shadow:var(--lg-halo-menu);padding:6px;' +
          'font-size:14px;color:var(--lg-text);}' +
          '.dsh-ling-menu .mi{padding:9px 12px;min-height:38px;display:flex;align-items:center;border-radius:9px;cursor:pointer;white-space:nowrap;font-size:14px;}' +
          '.dsh-ling-menu .mi:hover{background:var(--lg-hover-bg);color:var(--lg-hover-text);font-weight:600;}' +
          '.dsh-ling-menu .sep{height:1px;background:linear-gradient(90deg,var(--lg-border),transparent);margin:5px 10px;}' +
          '.dsh-ling-menu .hint{padding:4px 12px 7px;font-size:12px;opacity:.55;line-height:1.5;}' +
          '.dsh-ling-panel{position:fixed;z-index:9999;right:18px;top:18px;width:min(480px,94vw);max-height:86vh;' +
          'overflow:auto;background:linear-gradient(var(--lg-bg),var(--lg-bg)) padding-box,var(--lg-bgrad) border-box;' +
          'border:1px solid transparent;border-radius:16px;' +
          'box-shadow:var(--lg-halo);' +
          'padding:16px 18px;font-size:14px;color:var(--lg-text);}' +
          '.dsh-ling-panel h3{margin:0 0 12px;font-size:16px;font-weight:700;color:var(--lg-primary);letter-spacing:.2px;' +
          'position:relative;display:flex;align-items:center;gap:8px;border-bottom:none;padding-bottom:14px;' +
          'cursor:move;user-select:none;-webkit-user-select:none;}' +
          '.dsh-ling-panel h3::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;border-radius:2px;' +
          'background:linear-gradient(90deg,var(--lg-sky) 0%,var(--lg-primary) 55%,var(--lg-gold) 100%);opacity:.85;}' +
          '.dsh-ling-panel h3 .grip{opacity:.5;font-size:13px;}' +
          '.dsh-ling-panel h3::before{content:"⠿ ";opacity:.42;font-size:13px;}' +
          '.dsh-ling-panel h3 .hint{margin-left:auto;font-size:12px;font-weight:400;opacity:.55;}' +
          '.dsh-ling-panel .kv{font-family:ui-monospace,Consolas,monospace;font-size:13px;line-height:1.6;white-space:pre-wrap;' +
          'max-height:42vh;overflow:auto;background:var(--lg-rowbg);border:1px solid var(--lg-border-soft);border-radius:11px;padding:10px 12px;}' +
          '.dsh-ling-panel .btnrow{display:flex;gap:10px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap;}' +
          '.dsh-ling-panel button,.ling-form button{min-height:36px;padding:7px 18px;font-size:14px;border-radius:10px;' +
          'border:1px solid var(--lg-border);background:transparent;cursor:pointer;color:var(--lg-text);transition:all .12s;}' +
          '.dsh-ling-panel button:hover{border-color:var(--lg-accent);box-shadow:0 0 0 1px var(--lg-ring);}' +
          '.dsh-ling-panel button.primary,.ling-form button.primary{background:linear-gradient(135deg,var(--lg-sky),var(--lg-deep));' +
          'border-color:transparent;color:#fff;font-weight:600;box-shadow:0 3px 10px rgba(13,40,243,.28);}' +
          '.dsh-ling-panel button.primary:hover{filter:brightness(1.08);box-shadow:0 4px 14px rgba(13,40,243,.4);}' +
          '.dsh-ling-panel button:disabled{opacity:.5;cursor:wait;}' +
          '.ling-form{display:flex;flex-direction:column;gap:9px;}' +
          '.ling-form .row{display:flex;gap:10px;align-items:baseline;}' +
          '.ling-form label{width:84px;flex:none;font-size:13px;opacity:.78;}' +
          '.ling-form input,.ling-form select{flex:1;min-width:0;min-height:38px;padding:7px 10px;border:1px solid var(--lg-input);' +
          'border-radius:9px;background:transparent;color:var(--lg-text);font-size:14px;}' +
          '.ling-form input:focus,.ling-form select:focus{outline:none;box-shadow:0 0 0 2px var(--lg-ring);}' +
          '.ling-form textarea{flex:1;min-width:0;padding:8px 10px;border:1px solid var(--lg-input);border-radius:9px;' +
          'background:transparent;color:var(--lg-text);font-size:13.5px;font-family:inherit;resize:vertical;line-height:1.5;}' +
          // 只读列表沿用输入框的框(和"底线/规矩"同一视觉规格;习惯栏用它,2026-09-16 用户要求)
          '.ling-form .ling-box{flex:1;min-width:0;padding:8px 10px;border:1px solid var(--lg-input);border-radius:9px;' +
          'background:transparent;color:var(--lg-text);font-size:13.5px;font-family:inherit;line-height:1.5;' +
          'min-height:54px;max-height:220px;overflow:auto;}' +
          // 自绘下拉(ling-sel):展开列表也走 --lg-* 主题变量,不依赖浏览器原生配色
          '.ling-sel{position:relative;min-width:120px;height:38px;display:flex;align-items:center;gap:6px;' +
          'border:1px solid var(--lg-input);border-radius:9px;background:var(--lg-bg2);color:var(--lg-text);cursor:pointer;' +
          'padding:0 28px 0 10px;font-size:14px;user-select:none;-webkit-user-select:none;box-sizing:border-box;}' +
          '.ling-form .row .ling-sel{flex:1;min-width:0;}' +
          '.m-tools .ling-sel{flex:none;width:auto;min-width:132px;}' +
          '.ling-sel:hover{border-color:var(--lg-accent);}' +
          '.ling-sel.open{border-color:var(--lg-accent);box-shadow:0 0 0 2px var(--lg-ring);}' +
          '.ling-sel::after{content:"";position:absolute;right:11px;top:50%;width:7px;height:7px;margin-top:-5px;' +
          'border-right:2px solid var(--lg-text);border-bottom:2px solid var(--lg-text);transform:rotate(45deg);opacity:.75;pointer-events:none;}' +
          '.ling-sel.open::after{transform:rotate(225deg);margin-top:-2px;}' +
          '.ling-sel.dim{opacity:.5;pointer-events:none;}' +
          '.ling-sel .ls-list{position:absolute;top:calc(100% + 5px);left:0;right:0;z-index:9990;display:none;' +
          'background:var(--lg-bg2);border:1px solid var(--lg-accent);border-radius:10px;box-shadow:0 12px 28px rgba(0,0,0,.4);' +
          'overflow:auto;max-height:232px;padding:4px;}' +
          '.ling-sel.open .ls-list{display:block;}' +
          '.ls-item{padding:8px 12px;border-radius:7px;font-size:13.5px;color:var(--lg-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
          '.ls-item:hover{background:var(--lg-hover);}' +
          '.ls-item.on{background:var(--lg-hover-bg);color:var(--lg-hover-text);font-weight:700;}' +
          // 下拉列表显式底色:Chrome 对 transparent/disabled 的 select 会渲染成白底,深色主题下需强制
          '.ling-form select{background:var(--lg-bg2);color:var(--lg-text);-webkit-appearance:none;appearance:none;' +
          'background-image:linear-gradient(45deg,transparent 50%,var(--lg-text) 50%),linear-gradient(135deg,var(--lg-text) 50%,transparent 50%);' +
          'background-position:calc(100% - 18px) 55%,calc(100% - 13px) 55%;background-size:5px 5px;background-repeat:no-repeat;padding-right:26px;}' +
          '.ling-form select:disabled{background-color:var(--lg-bg2);color:var(--lg-text);opacity:.5;}' +
          '.ling-form select option,.ling-form select optgroup,.m-tools select option{background:var(--lg-bg2);color:var(--lg-text);}' +
          '.m-tools select{background-color:var(--lg-bg2);color:var(--lg-text);}' +
          '.ling-form .block{display:flex;flex-direction:column;gap:4px;}' +
          '.ling-form .h{font-size:12.5px;opacity:.7;margin-top:6px;}' +
          '.ling-preview{margin-top:10px;border:1px dashed var(--lg-accent);border-radius:10px;padding:10px 12px;' +
          'font-family:ui-monospace,Consolas,monospace;font-size:12.5px;white-space:pre-wrap;max-height:190px;overflow:auto;opacity:.92;line-height:1.6;' +
          'background:var(--lg-rowbg);}' +
          '.ling-check{display:inline-flex;gap:8px;align-items:center;font-size:13px;opacity:.9;margin-bottom:2px;}' +
          '.ling-mc{width:min(940px,92vw);height:min(780px,86vh);display:flex;flex-direction:column;}' +
          '.ling-mc h3{margin-bottom:8px;}' +
          '.ling-tabs{display:flex;gap:8px;border-bottom:1px solid var(--lg-border);padding-bottom:10px;margin-bottom:12px;}' +
          '.ling-tab{padding:8px 20px;min-height:38px;display:flex;align-items:center;border-radius:10px;cursor:pointer;' +
          'opacity:.62;border:1px solid transparent;font-size:14.5px;font-weight:600;transition:all .12s;}' +
          '.ling-tab:hover{opacity:1;}' +
          '.ling-tab.on{opacity:1;background:var(--lg-hover-bg);border-color:var(--lg-accent);color:var(--lg-hover-text);font-weight:700;}' +
          '.ling-mc .mc-body{flex:1;overflow:auto;min-height:0;font-size:14px;padding-right:2px;}' +
          '.m-tools{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px;}' +
          '.m-tools input[type=search],.m-tools select{min-height:38px;padding:6px 12px;border:1px solid var(--lg-input);' +
          'border-radius:9px;background:transparent;color:var(--lg-text);font-size:14px;}' +
          '.m-tools select:focus,.m-tools input:focus{outline:none;box-shadow:0 0 0 2px var(--lg-ring);}' +
          '.m-tools input[type=search]{min-width:240px;flex:1;}' +
          '.m-row{padding:11px 14px;border-radius:13px;border:1px solid transparent;margin:8px 0;' +
          'background-image:var(--lg-rowbg),var(--lg-bgrad-soft);background-clip:padding-box,border-box;background-origin:padding-box,border-box;}' +
          '.m-row:hover{filter:brightness(1.05);}' +
          '.m-row .m-title{font-size:15px;font-weight:650;line-height:1.45;}' +
          '.m-row .m-meta{opacity:.6;font-size:12.5px;margin:4px 0 8px;}' +
          '.m-acts{display:flex;gap:8px;flex-wrap:wrap;}' +
          '.m-acts button{min-height:32px;padding:4px 14px;font-size:13.5px;border-radius:9px;border:1px solid var(--lg-border);' +
          'background:transparent;cursor:pointer;color:var(--lg-text);transition:all .12s;}' +
          '.m-acts button:hover{border-color:var(--lg-accent);color:var(--lg-hover-text);background:var(--lg-hover-bg);}' +
          '.m-acts button.primary{background:linear-gradient(135deg,var(--lg-sky),var(--lg-deep));border-color:transparent;color:#fff;font-weight:600;}' +
          '.m-detail{margin-top:9px;padding-top:9px;border-top:1px dashed var(--lg-border);font-size:13px;white-space:pre-wrap;opacity:.88;line-height:1.6;}' +
          '.m-chip{display:inline-block;padding:2px 12px;border-radius:999px;font-size:12px;margin-left:8px;' +
          'border:1px solid var(--lg-accent);background:var(--lg-hover);color:var(--lg-primary);}' +
          '.m-empty{padding:34px;text-align:center;opacity:.55;font-size:14px;}' +
          '.stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:10px 0 14px;}' +
          '@media (max-width:760px){.stat-grid{grid-template-columns:repeat(2,1fr);}}' +
          '.stat{border:1px solid transparent;border-radius:13px;padding:10px 12px;text-align:center;' +
          'background-image:var(--lg-rowbg),var(--lg-bgrad-soft);background-clip:padding-box,border-box;background-origin:padding-box,border-box;}' +
          '.stat b{font-size:20px;color:var(--lg-primary);display:block;line-height:1.2;}' +
          '.stat span{font-size:12px;opacity:.66;display:block;margin-top:2px;}' +
          '.spirit-head{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px;}' +
          '.spirit-head .m-chip{margin-left:0;}' +
          '.spirit-note{font-size:13px;line-height:1.7;opacity:.9;margin:4px 0;}' +
          '.panel-actions{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0 4px;}' +
          '.ling-ask{position:fixed;z-index:10010;inset:0;display:flex;align-items:center;justify-content:center;' +
          'background:rgba(8,14,34,.38);backdrop-filter:blur(2px);}' +
          '.ling-ask .dsh-ling-panel{position:static;width:min(430px,92vw);max-height:80vh;}' +
          '.ling-ask .ask-title{font-weight:700;color:var(--lg-primary);margin:0 0 6px;font-size:15px;}' +
          '.ling-ask .ask-body{font-size:13px;opacity:.85;line-height:1.6;margin:4px 0 10px;white-space:pre-wrap;}' +
          '.ling-ask textarea{width:100%;box-sizing:border-box;min-height:86px;padding:9px 11px;border:1px solid var(--lg-input);' +
          'border-radius:10px;background:var(--lg-bg2);color:var(--lg-text);font-size:14px;font-family:inherit;resize:vertical;line-height:1.5;}' +
          '.ling-ask .ask-count{font-size:12px;margin-top:6px;opacity:.8;}' +
          '.ling-ask .ask-count.short{color:var(--lg-danger);opacity:1;}' +
          '.ling-ask .btnrow{margin-top:12px;}' +
          '.ling-seal{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:2px 0 10px;padding:9px 12px;border-radius:11px;' +
          'font-size:13px;background:var(--lg-rowbg);}' +
          '.ling-seal.locked{box-shadow:inset 0 0 0 1px rgba(224,85,85,.55);}' +
          '.ling-seal .st{flex:1;min-width:150px;opacity:.92;}' +
          '.ling-seal button{min-height:30px;padding:3px 13px;font-size:12.5px;border-radius:9px;border:1px solid var(--lg-border);' +
          'background:transparent;cursor:pointer;color:var(--lg-text);}' +
          '.ling-seal button:hover{border-color:var(--lg-accent);background:var(--lg-hover);}' +
          '.ling-seal button.primary{background:linear-gradient(135deg,var(--lg-sky),var(--lg-deep));border-color:transparent;color:#fff;font-weight:600;}' +
          '.ling-seal button.danger{border-color:rgba(224,85,85,.7);color:var(--lg-danger);}' +
          '.ling-seal button:disabled{opacity:.5;cursor:wait;}' +
          '.ling-form input:disabled,.ling-form select:disabled,.ling-form textarea:disabled{opacity:.5;}' +
          '.ling-cap{font-size:11.5px;margin-left:8px;padding:1px 8px;border-radius:999px;border:1px solid var(--lg-border);opacity:.8;}' +
          '.ling-cap.full{border-color:var(--lg-danger);color:var(--lg-danger);opacity:1;}' +
          '.ling-rule-h{display:flex;align-items:baseline;gap:6px;font-size:12.5px;opacity:.75;margin-top:8px;flex-wrap:wrap;}' +
          '.ling-rule-h .t{font-weight:700;opacity:.95;}' +
          '.ling-hist{max-height:150px;overflow:auto;border:1px solid var(--lg-border-soft);border-radius:10px;padding:4px 8px;' +
          'background:var(--lg-rowbg);font-size:12.5px;}' +
          '.ling-hist .hr{display:flex;align-items:center;gap:8px;padding:5px 2px;border-bottom:1px dashed var(--lg-border-soft);}' +
          '.ling-hist .hr:last-child{border-bottom:none;}' +
          '.ling-hist .hr .d{flex:1;opacity:.75;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
          '.ling-hist .hr button{min-height:26px;padding:1px 10px;font-size:12px;border-radius:8px;border:1px solid var(--lg-border);' +
          'background:transparent;color:var(--lg-text);cursor:pointer;flex:none;}' +
          '.ling-hist .hr button:hover{border-color:var(--lg-accent);background:var(--lg-hover);}' +
          '.ling-hist .hr button:disabled{opacity:.45;cursor:wait;}';
        document.head.appendChild(tag);
      }

      function dark() { return document.documentElement.getAttribute('data-ds-theme') === 'dark' ? '1' : '0'; }

      function closeOverlays() {
        document.querySelectorAll('.dsh-ling-menu,.dsh-ling-panel').forEach(function (n) {
          if (typeof n.__lingCleanup === 'function') { try { n.__lingCleanup(); } catch (e) {} }
          n.remove();
        });
        window.removeEventListener('mousedown', onDocDown, true);
        window.removeEventListener('keydown', onKeyDown, true);
      }
      function onDocDown(e) {
        if (document.querySelector('.ling-ask')) return;
        if (!e.target.closest('.dsh-ling-menu,.dsh-ling-panel,.dsh-ling-btn')) closeOverlays();
      }
      function onKeyDown(e) { if (document.querySelector('.ling-ask')) return; if (e.key === 'Escape') closeOverlays(); }
      function armOverlays() {
        window.addEventListener('mousedown', onDocDown, true);
        window.addEventListener('keydown', onKeyDown, true);
      }

      function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
      }

      function toast(msg) {
        var t = el('div', 'dsh-ling-menu');
        t.style.cssText = 'top:16px;left:50%;transform:translateX(-50%);cursor:default;min-width:auto;max-width:70vw;text-align:center;';
        t.appendChild(el('div', 'mi', msg));
        document.body.appendChild(t);
        setTimeout(function () { t.remove(); }, 3200);
      }

      /** 自绘下拉(ling-sel):配色全走 --lg-* 变量,展开列表与主题一致(不依赖浏览器原生配色)。
       *  接口兼容原生 select 的常用面:.value 读写 / .disabled 读写 / node 插入;选中回调 pick(v)。 */
      function makeSel(options, init, pick) {
        var val = init != null ? init : (options.length ? options[0].v : '');
        var list = el('div', 'ls-list');
        var cur = el('div', 'ls-current', '');
        var box = el('div', 'ling-sel');
        box.tabIndex = 0;
        box.appendChild(cur);
        box.appendChild(list);
        function labelOf(v) {
          for (var i = 0; i < options.length; i++) if (options[i].v === v) return options[i].l;
          return '';
        }
        function render() {
          cur.textContent = labelOf(val) || '—';
          list.textContent = '';
          options.forEach(function (o) {
            var it = el('div', 'ls-item' + (o.v === val ? ' on' : ''), o.l);
            it.onclick = function (e) {
              e.stopPropagation();
              if (o.v === val) { close(); return; }
              val = o.v;
              render();
              close();
              if (typeof pick === 'function') pick(val);
            };
            list.appendChild(it);
          });
        }
        function close() {
          box.classList.remove('open');
          document.removeEventListener('mousedown', onDoc, true);
        }
        function toggle() {
          if (box.classList.contains('dim')) return;
          if (box.classList.contains('open')) { close(); return; }
          box.classList.add('open');
          render();
          document.addEventListener('mousedown', onDoc, true);
        }
        function onDoc(e) {
          if (!e.target.closest('.ling-sel')) close();
        }
        box.addEventListener('click', function () { toggle(); });
        box.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') { e.stopPropagation(); close(); }
          else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        });
        render();
        var self = {
          node: box,
          get value() { return val; },
          set value(v) { val = v; render(); },
          get disabled() { return box.classList.contains('dim'); },
          set disabled(d) { if (d) box.classList.add('dim'); else box.classList.remove('dim'); if (d) close(); },
          open: toggle,
          close: close,
        };
        return self;
      }

      /** 打字确认框:minLen 字数门槛;noPaste=禁止粘贴(钥匙输入);mustEqual=必须精确一致;showKey=大字展示内容。 */
      function lingAsk(opts) {
        opts = opts || {};
        return new Promise(function (resolve) {
          if (document.querySelector('.ling-ask')) { resolve(null); return; }
          var ov = el('div', 'ling-ask');
          var p = el('div', 'dsh-ling-panel');
          p.style.cssText = '';
          var title = el('div', 'ask-title', opts.title || '确认');
          var body = el('div', 'ask-body', opts.body || '');
          var keyBox = null;
          if (opts.showKey) {
            keyBox = el('div', 'ask-key', String(opts.showKey));
            keyBox.style.cssText = 'user-select:text;margin:2px 0 10px;padding:12px 14px;border:1px dashed var(--lg-gold);border-radius:11px;' +
              'background:var(--lg-rowbg);font-size:18px;font-weight:700;letter-spacing:1.5px;text-align:center;color:var(--lg-primary);line-height:1.7;';
          }
          var ta = document.createElement('textarea');
          ta.placeholder = opts.placeholder || '';
          ta.value = opts.init || '';
          var count = el('div', 'ask-count', '');
          var minLen = opts.minLen || 0;
          var noPaste = !!opts.noPaste;
          var mustEqual = opts.mustEqual != null ? String(opts.mustEqual) : null;
          var btnRow = el('div', 'btnrow');
          var okBtn = el('button', 'primary', opts.okLabel || '确认');
          var cancelBtn = el('button', null, '取消');
          btnRow.appendChild(cancelBtn);
          btnRow.appendChild(okBtn);
          p.appendChild(title);
          p.appendChild(body);
          if (keyBox) p.appendChild(keyBox);
          p.appendChild(ta);
          p.appendChild(count);
          p.appendChild(btnRow);
          ov.appendChild(p);
          function val() { return ta.value.trim(); }
          function upd() {
            var v = val();
            var n = v.length;
            var okLen = minLen <= 0 || n >= minLen;
            var okEq = !mustEqual || v === mustEqual;
            okBtn.disabled = !(okLen && okEq);
            if (minLen > 0 && !okLen) {
              count.textContent = opts.countHint || ('还差 ' + (minLen - n) + ' 字(≥' + minLen + ' 字)');
              count.className = 'ask-count short';
            } else if (mustEqual && !okEq) {
              count.textContent = opts.countHint || (noPaste ? '与上方钥匙不一致 — 请照抄(输入框禁粘贴)' : '与要求不一致');
              count.className = 'ask-count short';
            } else if (minLen > 0 || mustEqual) {
              count.textContent = (mustEqual ? (noPaste ? '✓ 与钥匙一致(手动输入)' : '✓ 一致') : '✓ 字数达标(' + n + '/' + minLen + ')');
              count.className = 'ask-count';
            } else {
              count.textContent = '';
            }
          }
          ta.addEventListener('input', upd);
          if (noPaste) {
            ta.addEventListener('paste', function (e) { e.preventDefault(); e.stopPropagation(); });
            ta.addEventListener('drop', function (e) { e.preventDefault(); e.stopPropagation(); });
            ta.addEventListener('contextmenu', function (e) { e.preventDefault(); });
          }
          upd();
          function done(v) {
            document.removeEventListener('keydown', onK, true);
            ov.remove();
            resolve(v);
          }
          function onK(e) {
            if (e.key === 'Escape') { e.stopPropagation(); done(null); }
          }
          function onDoc(e) {
            if (e.target === ov || e.target === p) return;
            if (!e.target.closest('.ling-ask')) done(null);
          }
          document.addEventListener('keydown', onK, true);
          ov.addEventListener('mousedown', onDoc);
          okBtn.onclick = function () { done(val()); };
          cancelBtn.onclick = function () { done(null); };
          document.body.appendChild(ov);
          setTimeout(function () { ta.focus(); }, 30);
        });
      }

      // ---------------- 可拖动面板 ----------------
      function centerPanel(wrap) {
        var w = wrap.offsetWidth || 940;
        var hh = wrap.offsetHeight || 720;
        wrap.style.left = Math.max(8, Math.round((window.innerWidth - w) / 2)) + 'px';
        wrap.style.top = Math.max(8, Math.round((window.innerHeight - hh) / 3)) + 'px';
        wrap.style.right = 'auto';
      }

      function initPanelDrag(wrap, key) {
        var h3 = wrap.querySelector('h3');
        if (!h3) return;
        var saved = null;
        try {
          saved = JSON.parse(sessionStorage.getItem('dsh-ling-pos:' + key) || 'null');
        } catch (e) {}
        if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
          wrap.style.left = saved.left + 'px';
          wrap.style.top = saved.top + 'px';
          wrap.style.right = 'auto';
        } else if (key === 'mc') {
          centerPanel(wrap);
        }
        var dragging = false;
        var sx = 0, sy = 0, ox = 0, oy = 0;
        function onDown(e) {
          if (e.button !== 0) return;
          if (e.target && e.target.closest && e.target.closest('button,a,input,select,textarea')) return;
          dragging = true;
          var r = wrap.getBoundingClientRect();
          sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
          h3.style.cursor = 'grabbing';
          e.preventDefault();
        }
        function onMove(e) {
          if (!dragging) return;
          var r = wrap.getBoundingClientRect();
          var nx = ox + (e.clientX - sx);
          var ny = oy + (e.clientY - sy);
          nx = Math.max(4, Math.min(window.innerWidth - r.width - 4, nx));
          ny = Math.max(4, Math.min(window.innerHeight - 34, ny));
          wrap.style.left = nx + 'px';
          wrap.style.top = ny + 'px';
          wrap.style.right = 'auto';
        }
        function onUp() {
          if (!dragging) return;
          dragging = false;
          h3.style.cursor = 'move';
          try {
            sessionStorage.setItem('dsh-ling-pos:' + key, JSON.stringify({ left: Math.round(wrap.getBoundingClientRect().left), top: Math.round(wrap.getBoundingClientRect().top) }));
          } catch (e) {}
        }
        function onDbl() {
          try { sessionStorage.removeItem('dsh-ling-pos:' + key); } catch (e) {}
          if (key === 'mc') centerPanel(wrap);
          else { wrap.style.left = 'auto'; wrap.style.right = '18px'; wrap.style.top = '18px'; }
        }
        h3.addEventListener('mousedown', onDown);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        h3.addEventListener('dblclick', onDbl);
        wrap.__lingCleanup = function () {
          h3.removeEventListener('mousedown', onDown);
          h3.removeEventListener('dblclick', onDbl);
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
      }

      // ---------------- shared bits ----------------
      function modeName(m) { return m === 'work' ? '工作' : '生活'; }
      function otherMode(m) { return m === 'work' ? 'life' : 'work'; }
      function coreName(raw) {
        var parts = String(raw || '').split('/').map(function (s) { return s.trim(); }).filter(Boolean);
        return parts.length ? parts[0] : '器灵';
      }
      function shortErr(s) {
        var t = String(s || '').replace(/^selectModel failed:\s*/i, '');
        return t.length > 90 ? t.slice(0, 90) + '…' : t;
      }

      function pollPath(store) {
        var st = store.get();
        if (st.kind === 'global') return '/state?scope=global';
        return '/state' + qs({ sessionId: st.sessionId || undefined });
      }

      function applyStateToStore(store, r) {
        if (!r || !r.ok) return;
        setPronounFrom(r.persona);
        var patch = { mode: r.mode || store.get().mode, running: !!r.running, pending: r.pending || 0 };
        if (r.sessionId) patch.sessionId = r.sessionId;
        store.set(patch);
      }

      // ---------------- actions ----------------
      function toggleMode(store) {
        var st = store.get();
        var body = st.kind === 'global' ? { defaultOnly: true } : { sessionId: st.sessionId || undefined };
        return api('/mode/toggle', { method: 'POST', body: body }).then(function (r) {
          if (r && r.ok) {
            if (r.mode) store.set({ mode: r.mode, sessionId: r.sessionId || st.sessionId });
            if (r.queued) {
              toast('会话运行中——将在空闲后切换为 ' + modeName(r.mode) + ' 模式');
            } else if (r.applied === 'default-only') {
              toast('已更新默认模式:' + modeName(r.mode) + '(新会话将跟随并同步推理等级)' +
                (r.warning ? ';' + shortErr(r.warning) : ''));
            } else if (r.warning) {
              toast('已切换为 ' + modeName(r.mode) + ' 模式(新会话默认跟随);推理等级未同步:' + shortErr(r.warning));
            } else {
              toast('已切换为 ' + modeName(r.mode) + ' 模式(新会话默认跟随)');
            }
          } else {
            toast('切换失败:' + ((r && (r.reason || r.error)) || '未知'));
          }
          return r || {};
        }).catch(function () { toast('切换失败(网关不可达)'); return {}; });
      }

      function refreshMemory(store) {
        var st = store.get();
        return api('/memory/refresh', { method: 'POST', body: { sessionId: st.kind === 'global' ? null : (st.sessionId || null) } }).then(function (r) {
          if (!r || !r.ok) return toast('刷新失败');
          if (r.queued) toast('会话运行中——记忆将在空闲后刷新');
          else toast('记忆快照已刷新' + (Array.isArray(r.affected) ? '(' + r.affected.length + ' 个会话)' : ''));
          return r;
        });
      }

      function exportMemory() {
        return fetch(API + '/export').then(function (res) { return res.blob(); }).then(function (blob) {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'dsh-ling-memory-' + new Date().toISOString().slice(0, 10) + '.dshling.json';
          document.body.appendChild(a);
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
          toast('记忆包已导出');
        }).catch(function () { toast('导出失败'); });
      }

      function openPanel(store) {
        ensureStyle();
        closeOverlays();
        var st = store.get();
        var global = st.kind === 'global';
        var url = global ? '/state?scope=global&l0Preview=1' : '/state' + qs({ sessionId: st.sessionId || undefined, l0Preview: '1' });
        var wrap = el('div', 'dsh-ling-panel');
        wrap.dataset.dark = dark();
        var h = el('h3', null, 'dsh-器灵' + (global ? '(全局默认)' : ''));
        h.appendChild(el('div', 'hint', global ? '此视图无活动会话:此按钮管理新会话默认模式' : '左键=切换模式 · 悬停 1.5s=菜单 · Esc 关闭'));
        wrap.appendChild(h);
        var kv = el('div', 'kv', '加载中…');
        wrap.appendChild(kv);
        var btnRow = el('div', 'btnrow');
        var close = el('button', null, '关闭');
        btnRow.appendChild(close);
        wrap.appendChild(btnRow);
        document.body.appendChild(wrap);
        armOverlays();
        initPanelDrag(wrap, 'status');
        api(url).then(function (r) {
          if (!r || !r.ok) {
            kv.textContent = '暂无状态: ' + JSON.stringify(r || {});
            return;
          }
          var core = coreName(r.persona && r.persona.aiName);
          var disp = core === '器灵' ? 'dsh-器灵' : ('dsh-器灵 · ' + core);
          if (global) disp += '(全局默认)';
          h.textContent = '';
          h.appendChild(document.createTextNode(disp));
          h.appendChild(el('div', 'hint', global ? '此视图无活动会话:此按钮管理新会话默认模式' : '左键=切换模式 · 悬停 1.5s=菜单 · Esc 关闭'));
          var lines = [
            global ? '全局默认(新会话跟随)' : ('当前会话: ' + (r.sessionId || '(无)')),
            '模式: ' + (r.modeLabel || r.mode) + (r.running ? ' · 运行中(冻结)' : ' · 空闲'),
            '待应用更新: ' + (r.pending || 0),
          ];
          if (r.snapshot) {
            lines.push('记忆快照: 已定稿 ' + (r.snapshot.chars || 0) + ' 字符 · mode=' + (r.snapshot.mode || '?') + (r.snapshot.stale ? ' · 待刷新' : ''));
          }
          lines = lines.concat([
            '',
            '人格: 自称=' + ((r.persona && r.persona.aiName) || '(无)') + ' 称呼=' + ((r.persona && r.persona.userTitle) || '(无)') + ' 语气=' + ((r.persona && r.persona.tone) || 'natural') +
              ' · ' + ((r.persona && r.persona.sealed) ? '🔒已定型' : '未定型'),
            'L0 注入预览:',
          ]);
          var l0 = (r.l0PreviewText || '(空 — 人格开关关闭或全部字段为空,仍注入最小身份段)').split('\n').map(function (s2) { return '  ' + s2; });
          lines = lines.concat(l0);
          lines = lines.concat([
            '',
            '记忆库: 概述 ' + (r.memory && r.memory.overviews) + ' 条 · DSH 原始轮次会话 ' + (r.memory && r.memory.rawTurnSessions) + ' 个',
            '指纹: ' + ((r.memory && r.memory.fingerprint) || '').slice(0, 16),
            'L1(当前选择):',
          ]);
          if (r.memory && r.memory.l1 && r.memory.l1.items.length) {
            lines = lines.concat(r.memory.l1.items.map(function (i) { return '  · ' + i.line; }));
            if (r.memory.l1.dropped) lines.push('  (省略 ' + r.memory.l1.dropped + ' 条)');
          } else if (!global) {
            lines.push('  (无概述数据 — 待 v0 历史语料导入)');
          }
          kv.textContent = lines.join('\n');
          if (r.running) toast('该会话运行中——人格/记忆更新将在空闲后生效');
        });
        close.onclick = closeOverlays;
      }

      // ---------------- 人格中心(L0;惯例/底线/定型锁;操作=手术) ----------------
      function openPersonaEditor(prefill) {
        ensureStyle();
        closeOverlays();
        var wrap = el('div', 'dsh-ling-panel');
        wrap.dataset.dark = dark();
        var h = el('h3', null, '人格中心 · L0(称呼 / 自称 / 规矩·习惯·底线)');
        h.appendChild(el('div', 'hint', '保存即对空闲会话生效;运行中会话在空闲后生效(D4)'));
        wrap.appendChild(h);

        var form = el('div', 'ling-form');
        var refs = {};

        var sealedNow = false;   // 服务端定型状态
        var unlocked = false;    // 本次会话承诺已验证(仅存于内存)
        var unlockPhrase = '';
        var sealPhrase = '';     // 定型承诺句明文(服务端回显用;锁只造庄重,不保密)

        function row(label, node) {
          var r = el('div', 'row');
          r.appendChild(el('label', null, label));
          r.appendChild(node);
          form.appendChild(r);
          return r;
        }
        function input(kind, val, rows) {
          var n = document.createElement(kind);
          if (kind === 'textarea') {
            n.rows = rows || 2;
            n.style.cssText = 'min-height:' + Math.max(54, (rows || 2) * 22 + 12) + 'px;';
          }
          n.value = val == null ? '' : val;
          return n;
        }
        /** 诞生仪式草稿 → 字段旁建议(乙方案:人审终审在人格中心)。
         *  插入位置 = 表单纵向流(该行之后)—— 不能塞进横向 .row(flex 无 wrap 会挤压溢出)。 */
        function renderGenesisSuggest(rowEl, label, value, getRef) {
          if (!value) return;
          var line = el('div', 'ling-rule-h');
          line.style.cssText = 'display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap;width:100%;margin:1px 0 4px;font-size:12.5px;opacity:.92;';
          line.appendChild(el('span', null, she('她建议 · ') + label + ':'));
          var valSpan = el('span', null, String(value));
          valSpan.style.cssText = 'flex:1 1 260px;min-width:0;word-break:break-word;white-space:pre-wrap;line-height:1.5;';
          var bFill = el('button', null, '填入');
          bFill.type = 'button';
          bFill.style.cssText = 'min-height:24px;padding:0 10px;font-size:12px;flex:none;align-self:center;';
          bFill.onclick = function () {
            var n = getRef();
            if (n.disabled) { toast('该字段在定型下只读 —— 请先「对人格做手术」或「重归摇篮」后填入'); return; }
            n.value = value;
            line.textContent = '';
            line.appendChild(el('span', 'h', '✓ 已填入,可在上方直接修改后再保存'));
            schedulePreview();
          };
          line.appendChild(valSpan);
          line.appendChild(bFill);
          form.insertBefore(line, rowEl.nextSibling);
        }

        // 定型状态条(置于表单最前,一眼可见)
        var sealBar = el('div', 'ling-seal');
        sealBar.appendChild(el('span', 'st', '…'));
        form.appendChild(sealBar);

        var chkRow = el('div', 'ling-check');
        var enabledBox = document.createElement('input');
        enabledBox.type = 'checkbox';
        enabledBox.checked = true;
        chkRow.appendChild(enabledBox);
        chkRow.appendChild(el('span', null, '启用人格与记忆注入(关=完全原生助手)'));
        form.appendChild(chkRow);

        row('对你的称呼', refs.userTitle = input('input', ''));
        form.appendChild(el('div', 'h', '写法:正式名/昵称,正式名在前(如 张明/明明)。工作模式自动称正式名(张明),生活模式自动称昵称(明明);单名则两模式同称。'));
        var nameRow = row('AI 自称', refs.aiName = input('input', ''));
        form.appendChild(el('div', 'h', '多个自称用 / 并列(如 器灵/小灵:正式名在前,昵称在后):注入正文整段呈现;界面显示名与身份段标题取第一个(正式名,如 器灵)。'));
        // 代词:预设不含「祂」——中文里祂专指神祇,放进预设等于替用户宣称神性;想用的人在"自定义"里填
        var pronounSel = makeSel([
          { v: '她', l: '她' }, { v: '他', l: '他' }, { v: 'TA', l: 'TA' }, { v: '它', l: '它' }, { v: '__custom__', l: '自定义…' },
        ], '她', function (v) { pronounInput.style.display = v === '__custom__' ? '' : 'none'; });
        var pronounInput = input('input', '');
        pronounInput.placeholder = '自定义代词(≤6 字,如 祂)';
        pronounInput.style.cssText = 'display:none;max-width:160px;';
        var pronounRow = row('代词(第三人称)', pronounSel.node);
        pronounRow.appendChild(pronounInput);
        form.appendChild(el('div', 'h', '别人提到她/他时怎么称呼,以及给模型看的提示词用哪个代词;默认「她」,想用别的选「自定义…」。只影响文案,不改数据。'));
        var titleRow = row('定位自述', refs.aiTitle = input('textarea', '', 5));
        form.appendChild(el('div', 'h', '可多行书写;注入身份句时压缩为一行。空 = 按默认身份句注入。'));
        // 诞生仪式草稿(乙):来自 genesis 面板的选定建议,浮在字段旁,人审终审在此
        if (prefill && prefill.aiName) renderGenesisSuggest(nameRow, '名字', prefill.aiName, function () { return refs.aiName; });
        if (prefill && prefill.aiTitle) renderGenesisSuggest(titleRow, '自述', prefill.aiTitle, function () { return refs.aiTitle; });
        var draftZone = el('div', 'ling-draft-zone');
        draftZone.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
        var draftBtn = el('button', null, '✨ AI 起草定位自述');
        draftBtn.type = 'button';
        var draftOut = el('div', 'ling-draft-out', '');
        draftOut.style.cssText = 'width:100%;';
        draftZone.appendChild(draftBtn);
        draftZone.appendChild(el('span', 'h', '基于规矩/底线/身世/风格生成候选 — 仅填入本栏不落盘,采用后仍需保存'));
        draftZone.appendChild(draftOut);
        form.appendChild(draftZone);
        var toneSel = makeSel([
          { v: 'natural', l: '自然亲切' }, { v: 'literary', l: '文雅' },
          { v: 'concise', l: '简洁直接' }, { v: 'playful', l: '活泼俏皮' },
        ], 'natural', schedulePreview);
        row('语气基线', toneSel.node);
        var TONE_OPT = [{ v: '', l: '跟随默认' }, { v: 'natural', l: '自然亲切' }, { v: 'literary', l: '文雅' },
          { v: 'concise', l: '简洁直接' }, { v: 'playful', l: '活泼俏皮' }];
        var toneWorkSel = makeSel(TONE_OPT, '', schedulePreview);
        var toneLifeSel = makeSel(TONE_OPT, '', schedulePreview);
        row('工作模式语气', toneWorkSel.node);
        row('生活模式语气', toneLifeSel.node);
        form.appendChild(el('div', 'h', '切换 工作/生活 模式时,语气基线自动用对应档(「跟随默认」= 用上方语气基线)。'));
        // 语气 P1:按记忆归纳(自性类 = 自由生长,采纳免手术)
        var toneZone = el('div', 'block');
        var toneHead = el('div', 'ling-rule-h');
        toneHead.appendChild(el('span', 't', '按记忆归纳语气'));
        toneHead.appendChild(el('span', null, she('她读你在工作侧与生活侧的痕迹后给出判断;语气与风格属"自性",采纳即生效、无需手术(仅可逆动作:枚举替换 + 风格追加)')));
        toneZone.appendChild(toneHead);
        var bTone = el('button', null, she('✨ 让她读记忆、归纳语气'));
        bTone.type = 'button';
        toneZone.appendChild(bTone);
        var toneOut = el('div', 'ling-draft-out', '');
        toneOut.style.cssText = 'width:100%;';
        toneZone.appendChild(toneOut);
        form.appendChild(toneZone);
        function toneRow(label, side, adv) {
          var line = el('div', 'ling-draft-item');
          line.style.cssText = 'display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;margin:6px 0;font-size:13px;';
          var txt = el('span', null, label + ':' + (adv.tone ? ({ natural: '自然亲切', literary: '文雅', concise: '简洁直接', playful: '活泼俏皮' }[adv.tone] || adv.tone) : '(这次没给出)') +
            (adv.evidence ? '\n  依据:' + adv.evidence : ''));
          txt.style.cssText = 'flex:1 1 240px;min-width:0;line-height:1.6;white-space:pre-wrap;word-break:break-word;';
          line.appendChild(txt);
          if (adv.tone) {
            var bUse = el('button', 'primary', '采用这一档');
            bUse.type = 'button';
            bUse.onclick = function () {
              bUse.disabled = true;
              api('/persona/grow', { method: 'POST', body: { tone: side === 'work' ? { work: adv.tone } : { life: adv.tone } } }).then(function (r2) {
                bUse.disabled = false;
                if (r2 && r2.ok) { toast('已采纳' + label + '(自由生长,无需手术)'); refill(true); }
                else toast('采纳失败:' + ((r2 && (r2.message || r2.reason)) || '未知'));
              }).catch(function () { bUse.disabled = false; toast('采纳失败(网关不可达)'); });
            };
            line.appendChild(bUse);
          }
          if (adv.note) {
            var bNote = el('button', null, '追加语气注');
            bNote.type = 'button';
            bNote.title = adv.note;
            bNote.onclick = function () {
              bNote.disabled = true;
              api('/persona/grow', { method: 'POST', body: { styleAppend: side === 'work' ? { work: adv.note } : { life: adv.note } } }).then(function (r2) {
                bNote.disabled = false;
                if (r2 && r2.ok) { toast(r2.appended ? '已追加到' + (side === 'work' ? '工作' : '生活') + '风格文本' : '这句已经在风格文本里了'); refill(true); }
                else toast('追加失败:' + ((r2 && (r2.message || r2.reason)) || '未知'));
              }).catch(function () { bNote.disabled = false; toast('追加失败(网关不可达)'); });
            };
            line.appendChild(bNote);
          }
          toneOut.appendChild(line);
        }
        bTone.onclick = function () {
          bTone.disabled = true;
          var old = bTone.textContent;
          bTone.textContent = she('她在读你的工作与生活…');
          toneOut.textContent = '';
          api('/persona/tone-advice', { method: 'POST', body: {} }).then(function (r) {
            bTone.disabled = false;
            bTone.textContent = old;
            if (!r || !r.ok) { toneOut.appendChild(el('div', 'm-meta', '✗ ' + ((r && r.message) || '归纳失败'))); return; }
            toneOut.appendChild(el('div', 'm-meta', '取材:工作侧 ' + (r.sampled.work || 0) + ' 条 · 生活侧 ' + (r.sampled.life || 0) + ' 条(加权抽样)'));
            toneRow('工作语气建议', 'work', r.result.work);
            toneRow('生活语气建议', 'life', r.result.life);
          }).catch(function () { bTone.disabled = false; bTone.textContent = old; toneOut.appendChild(el('div', 'm-meta', '✗ 归纳失败(网关不可达)')); });
        };
        var langSel = makeSel([
          { v: 'follow', l: '跟随用户' }, { v: 'zh', l: '中文' }, { v: 'en', l: 'English' },
        ], 'follow', schedulePreview);
        row('语言', langSel.node);

        var bBl = el('div', 'block');
        var blHead = el('div', 'ling-rule-h');
        blHead.appendChild(el('span', 't', '底线'));
        blHead.appendChild(el('span', null, '至多 5 条 · 不可动摇之事;定型后修改需承诺句'));
        var capEl = el('span', 'ling-cap', '0 / 5');
        blHead.appendChild(capEl);
        bBl.appendChild(blHead);
        refs.bottomLines = input('textarea', '');
        bBl.appendChild(refs.bottomLines);
        form.appendChild(bBl);

        var bRules = el('div', 'block');
        var hrHead = el('div', 'ling-rule-h');
        hrHead.appendChild(el('span', 't', '规矩'));
        hrHead.appendChild(el('span', null, '你的指令 · 每行一条 · 可直接增删;会话里说"记进规矩"也行(我必须带上你的原话作凭据)'));
        bRules.appendChild(hrHead);
        refs.hardRules = input('textarea', '', 7);
        bRules.appendChild(refs.hardRules);
        form.appendChild(bRules);

        // 习惯:只能由她长出来、双方确认后落地 —— 这里**只读**(不能直接写)
        var bHabits = el('div', 'block');
        var hbHead = el('div', 'ling-rule-h');
        hbHead.appendChild(el('span', 't', '习惯'));
        hbHead.appendChild(el('span', null, she('她长出来的 · 不能在这里直接写;新增走"提议 → 你点头",确认后在此可见')));
        bHabits.appendChild(hbHead);
        refs.habitsBox = el('div', 'ling-box');
        bHabits.appendChild(refs.habitsBox);
        form.appendChild(bHabits);

        var bLore = el('div', 'block');
        bLore.appendChild(el('div', 'h', '扩展设定 / 世界观(器灵档案等,原样注入)'));
        refs.extraLore = input('textarea', '', 7);
        bLore.appendChild(refs.extraLore);
        form.appendChild(bLore);

        var bW = el('div', 'block');
        bW.appendChild(el('div', 'h', '工作模式附加风格'));
        refs.stylesWork = input('textarea', '');
        bW.appendChild(refs.stylesWork);
        form.appendChild(bW);

        var bL = el('div', 'block');
        bL.appendChild(el('div', 'h', '生活模式附加风格'));
        refs.stylesLife = input('textarea', '');
        bL.appendChild(refs.stylesLife);
        form.appendChild(bL);

        wrap.appendChild(form);

        // 她的话(诞生草稿·语气建议/相处观察):人审后一键记入惯例(自由成长,无需手术)
        if (prefill && Array.isArray(prefill.hints) && prefill.hints.length) {
          var herBlock = el('div', 'block');
          var herHead = el('div', 'ling-rule-h');
          herHead.appendChild(el('span', 't', she('她的话(诞生草稿)')));
          herHead.appendChild(el('span', null, '语气建议与相处观察:觉得好就点「认可这条习惯」(成长通道,无需手术);不认可可直接忽略'));
          herBlock.appendChild(herHead);
          var pendingN = prefill.hints.length;
          prefill.hints.forEach(function (h) {
            var line = el('div', 'ling-draft-item');
            line.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin:5px 0;font-size:13px;';
            var cap = el('span', 'm-chip', h.label);
            cap.style.cssText = 'flex:none;';
            var txt = el('span', null, h.text);
            txt.style.cssText = 'flex:1;min-width:0;line-height:1.6;opacity:.95;white-space:pre-wrap;word-break:break-word;';
            var bt = el('button', null, '认可这条习惯');
            bt.type = 'button';
            bt.onclick = function () {
              bt.disabled = true;
              api('/persona/hint-adopt', { method: 'POST', body: { text: h.text } }).then(function (r2) {
                bt.disabled = false;
                if (r2 && r2.ok) {
                  pendingN -= 1;
                  line.textContent = '';
                  line.appendChild(el('span', 'h', r2.exists ? '这条已在习惯里 ✓' : '✓ 已认可为习惯(第 ' + (r2.habits ?? '?') + ' 条)—— 可在人格中心「习惯」栏查看'));
                  if (!pendingN) {
                    var done = el('div', 'm-meta', '');
                    done.style.cssText = 'margin-top:4px;opacity:.85;';
                    done.textContent = she('她的话都已安放 —— 若想改,习惯栏里随时可以。');
                    herBlock.appendChild(done);
                  }
                } else {
                  toast('记入失败:' + ((r2 && (r2.message || r2.reason || r2.error)) || '未知'));
                }
              }).catch(function () { bt.disabled = false; toast('记入失败(网关不可达)'); });
            };
            line.appendChild(cap);
            line.appendChild(txt);
            line.appendChild(bt);
            herBlock.appendChild(line);
          });
          wrap.appendChild(herBlock);
        }

        var preview = el('div', 'ling-preview', 'L0 预览:加载中…');
        wrap.appendChild(preview);

        // 历史快照(自动留存;可回滚)
        var histWrap = el('div', 'block');
        var histHead = el('div', 'ling-rule-h');
        histHead.appendChild(el('span', 't', '变更记录'));
        histHead.appendChild(el('span', null, '每次保存自动留档「保存后的档案」(内容无变化不重复),可整体回滚'));
        histWrap.appendChild(histHead);
        var histList = el('div', 'ling-hist', '加载中…');
        histWrap.appendChild(histList);
        wrap.appendChild(histWrap);

        var btnRow = el('div', 'btnrow');
        var closeBtn = el('button', null, '关闭');
        var saveBtn = el('button', 'primary', '保存');
        btnRow.appendChild(closeBtn);
        btnRow.appendChild(saveBtn);
        wrap.appendChild(btnRow);
        document.body.appendChild(wrap);
        armOverlays();
        initPanelDrag(wrap, 'persona');

        function linesOf(ta) {
          return ta.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
        }
        function collect(skipEnabled) {
          return {
            persona: {
              enabled: skipEnabled ? undefined : enabledBox.checked,
              userTitle: refs.userTitle.value.trim(),
              aiName: refs.aiName.value.trim(),
              aiTitle: refs.aiTitle.value.trim(),
              pronoun: (pronounSel.value === '__custom__' ? (pronounInput.value.trim().slice(0, 6) || '她') : pronounSel.value),
              tone: toneSel.value,
              toneWork: toneWorkSel.value,
              toneLife: toneLifeSel.value,
              language: langSel.value,
              hardRules: linesOf(refs.hardRules),
              bottomLines: linesOf(refs.bottomLines).slice(0, 5),
              extraLore: refs.extraLore.value.trim(),
            },
            styles: {
              work: refs.stylesWork.value.trim(),
              life: refs.stylesLife.value.trim(),
            },
          };
        }

        function blCount() {
          var n = linesOf(refs.bottomLines).length;
          capEl.textContent = n + ' / 5';
          capEl.className = 'ling-cap' + (n > 5 ? ' full' : '');
          capEl.title = n > 5 ? '超出部分不会保存(仅前 5 条生效)' : '至多 5 条';
        }

        var previewTimer = null;
        function schedulePreview() {
          if (previewTimer) clearTimeout(previewTimer);
          previewTimer = setTimeout(firePreview, 420);
        }
        function firePreview() {
          previewTimer = null;
          var p = collect(true);
          api('/state?scope=global&l0Preview=1&previewPersona=' + encodeURIComponent(JSON.stringify(p.persona)) +
            '&previewStyles=' + encodeURIComponent(JSON.stringify(p.styles))).then(function (r) {
            if (r && r.ok) preview.textContent = r.l0PreviewText || '(空 — 全字段为空仍注入最小身份段;关掉启用开关则完全不注入)';
            else preview.textContent = '预览失败';
          }).catch(function () { preview.textContent = '预览失败(网关不可达)'; });
        }

        function inputLock(locked) {
          [enabledBox, toneSel, toneWorkSel, toneLifeSel, langSel, refs.userTitle, refs.aiName, refs.aiTitle, refs.hardRules, refs.bottomLines,
            refs.extraLore, refs.stylesWork, refs.stylesLife].forEach(function (n) { n.disabled = locked; });
          // 代词同属"契约类":定型后改动需手术(与 自称/称呼 同规格)
          pronounSel.disabled = locked;
          pronounInput.disabled = locked;
          // draftBtn 例外:自我总结属于"自由生长",定型后仍可起草(采纳走专用通道,无需手术)
        }
        // AI 起草定位自述:只读调用,不落盘;可编辑时候选填入栏;定型(未手术)时采纳直接走专用通道落盘
        function fireDraft() {
          if (draftBtn.disabled) return;
          draftBtn.disabled = true;
          var oldTxt = draftBtn.textContent;
          draftBtn.textContent = '起草中…';
          draftOut.textContent = '';
          api('/persona/draft', { method: 'POST', body: {} }).then(function (r) {
            draftBtn.disabled = false;
            draftBtn.textContent = oldTxt;
            if (!r || !r.ok || !r.candidates || !r.candidates.length) {
              draftOut.appendChild(el('div', 'm-meta', '起草失败:' + ((r && r.message) || '未知')));
              return;
            }
            var growing = sealedNow && !unlocked;
            if (growing) draftOut.appendChild(el('div', 'm-meta', she('她自述的成长:候选由你人审,采纳即生效(仅更新定位自述,无需手术)。')));
            r.candidates.forEach(function (cand, i) {
              var line = el('div', 'ling-draft-item');
              line.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin:5px 0;font-size:13px;';
              var txt = el('span', null, '候选 ' + (i + 1) + ': ' + cand);
              txt.style.cssText = 'flex:1;line-height:1.5;opacity:.92;';
              var take = el('button', 'primary', growing ? '采纳(即生效)' : '采用');
              take.type = 'button';
              take.onclick = function () {
                if (growing) {
                  // 自由生长通道:定型且未手术 → 仅 aiTitle 单字段落盘
                  take.disabled = true;
                  api('/persona/self-summary', { method: 'POST', body: { text: cand } }).then(function (rr) {
                    take.disabled = false;
                    if (rr && rr.ok) {
                      draftOut.textContent = '';
                      draftOut.appendChild(el('div', 'm-meta', she('✓ 已采纳她的自我总结 —— 这是自由生长的部分,无需手术。')));
                      refill(true);
                      toast('已采纳自我总结(自由生长中)');
                    } else {
                      draftOut.appendChild(el('div', 'm-meta', '✗ 保存失败:' + ((rr && (rr.message || rr.reason)) || '未知')));
                    }
                  }).catch(function () { take.disabled = false; toast('保存失败(网关不可达)'); });
                  return;
                }
                refs.aiTitle.value = cand;
                draftOut.textContent = '';
                draftOut.appendChild(el('div', 'm-meta', '已填入定位自述栏 — 别忘了「保存」(定型中需先解锁)。'));
                schedulePreview();
              };
              line.appendChild(txt);
              line.appendChild(take);
              draftOut.appendChild(line);
            });
            var again = el('button', null, '✨ 换一批');
            again.type = 'button';
            again.onclick = fireDraft;
            var againRow = el('div', 'btnrow');
            againRow.appendChild(again);
            draftOut.appendChild(againRow);
          }).catch(function () {
            draftBtn.disabled = false;
            draftBtn.textContent = oldTxt;
            draftOut.appendChild(el('div', 'm-meta', '起草失败(网关不可达)'));
          });
        }
        if (draftBtn) draftBtn.onclick = fireDraft;
        var lastP = null; // 最近一次 /state 拿到的 persona(供锁态变化时重绘只读区)
        function applyLockUI() {
          var locked = sealedNow && !unlocked;
          sealBar.className = 'ling-seal' + (sealedNow ? ' locked' : '');
          sealBar.textContent = '';
          var st = el('span', 'st', '');
          if (!sealedNow) {
            st.textContent = she('🌱 她尚在成长,档案由你守护。愿意放手时,立下一句承诺,自此自由生长。');
            var bLock = el('button', 'primary', she('🌱 放手,让她自由生长'));
            bLock.onclick = doLock;
            sealBar.appendChild(st);
            sealBar.appendChild(bLock);
          } else if (unlocked) {
            st.textContent = '🔓 手术中(承诺句已验证)— 改动保存即生效;关闭后自动缝合回只读。';
            var bRelock = el('button', null, '手术完成');
            bRelock.onclick = relock;
            var bUnseal = el('button', 'danger', '重归摇篮…');
            bUnseal.onclick = unsealPermanent;
            sealBar.appendChild(st);
            sealBar.appendChild(bRelock);
            sealBar.appendChild(bUnseal);
          } else {
            st.textContent = she('🌱 她已自由生长中 —— 若需对她做手术,亲手敲出当初的承诺句即可开启(≥10 字;输入框禁粘贴;界面会回显原句)。');
            var bUnlock = el('button', null, '🔓 对人格做手术…');
            bUnlock.onclick = doUnlock;
            sealBar.appendChild(st);
            sealBar.appendChild(bUnlock);
          }
          inputLock(locked);
          saveBtn.disabled = locked;
          // 锁态变了要重绘习惯栏:它是只读渲染,删除入口只在 unlocked 时出现
          // (2026-09-16 修 bug:解锁后不重绘 → 「删掉」按钮永远不出现)
          if (lastP) renderHabits(lastP);
        }
        function checkKey(k) {
          return api('/persona/check', { method: 'POST', body: { unlock: k } });
        }
        function doUnlock() {
          var hintPhrase = sealPhrase;
          lingAsk({
            title: '对人格做手术(仪式)',
            body: (hintPhrase
              ? '你定型时写下的承诺句是:\n「' + hintPhrase + '」\n\n手术前请郑重地亲手敲一遍以确认(输入框禁粘贴,逐字敲出)。'
              : '档案已定型,但旧档案未记录明文承诺。输入一句 ≥10 字的新承诺,它将被采纳为定型承诺句并开启本次手术。\n\n若想重新立誓,也请在下面输入你的新承诺。'),
            placeholder: hintPhrase ? '手动敲出上方承诺句…' : '写下新的定型承诺句…',
            minLen: 10, noPaste: true, okLabel: '郑重解锁',
          }).then(function (v) {
            if (!v) return;
            checkKey(v).then(function (r) {
              if (r && r.ok && r.valid) {
                unlocked = true;
                unlockPhrase = v;
                if (r.adopt) sealPhrase = v;
                applyLockUI();
                toast(r.adopt ? '旧档案无明文:此句已成为定型承诺,本次已解锁' : '承诺一致,本次已解锁 — 保存时自动携带');
              } else {
                toast((r && r.message) || '与定型时的承诺不一致,请重试');
              }
            }).catch(function () { toast('校验失败(网关不可达)'); });
          });
        }
        function relock() {
          unlocked = false;
          unlockPhrase = '';
          applyLockUI();
          toast('手术完成 — 档案已重新定型(本次修改已封存;如需保留请先保存)');
        }
        function doLock() {
          lingAsk({
            title: '真的要放手了吗?',
            body: '确定从现在开始,放手让我自由生长了吗?\n\n那么,请对我承诺——写下一句属于我们的话(≥10 字):\n\n(小字:以后若需对我"做手术"——修改自称/称呼/语气/风格/底线——都必须亲手敲出这句承诺;日常的规矩增删与习惯成长仍会自然发生,不会打扰你。承诺句明文保存,仅为未来回显提醒,不保密。)',
            placeholder: '例:对我做手术时,一定轻拿轻放、先备份后落刀',
            minLen: 10, okLabel: '我承诺,放手让你生长',
            countHint: '承诺句 ≥10 字,建议是你自己会记住、有分量的话',
          }).then(function (v) { if (v) saveWith({ persona: { sealed: true } }, she('她已获得自由生长的契约'), v); });
        }
        function unsealPermanent() {
          lingAsk({
            title: '重归摇篮?',
            body: '重归摇篮 = 解除定型:如同长大的孩子回家,回到可塑可育的成长期,档案恢复自由修改(历史档案仍保留,可随时回滚)。\n\n请输入定型时的承诺句以确认(输入框禁粘贴)。',
            placeholder: '手动输入定型承诺句…',
            minLen: 10, noPaste: true, okLabel: '重归摇篮',
          }).then(function (v) { if (v) saveWith({ persona: { sealed: false } }, '已重归摇篮(解除定型)', v); });
        }

        function saveWith(extra, label, phrase) {
          if (sealedNow && !phrase && !unlocked) { toast('档案已定型 — 请输入承诺句后才能保存'); return; }
          var patch = collect(false);
          if (extra && extra.persona) patch.persona = Object.assign(patch.persona, extra.persona);
          var payload = { patch: patch, unlock: phrase || (unlocked ? unlockPhrase : undefined) };
          saveBtn.disabled = true;
          api('/persona', { method: 'POST', body: payload }).then(function (r) {
            if (r && r.ok) {
              if (r.bottomCapped) toast('⚠ 底线超过 5 条:仅前 5 条已保存');
              if (r.histKey) renderHist();
              refill(true); // 以服务端为准回填(含定型状态翻转)
              toast((label || '已保存') + (r.affected && r.affected.length ? ' · L0 已刷新 ' + r.affected.length + ' 个会话' : ''));
            } else {
              var reason = (r && r.message) || (r && r.reason) || (r && r.error) || '未知';
              if (r && r.reason === 'sealed') { sealedNow = true; unlocked = false; applyLockUI(); }
              toast('保存失败:' + reason);
              saveBtn.disabled = false;
            }
          }).catch(function () { toast('保存失败(网关不可达)'); saveBtn.disabled = false; });
        }
        /** 保存入口:锁定态点保存 → 直接弹承诺句输入,一条龙完成(不再依赖解锁状态缓存)。 */
        function trySave() {
          if (!sealedNow || unlocked) { saveWith(null, '人格已保存'); return; }
          lingAsk({
            title: '保存需承诺句',
            body: '档案已定型。保存本次修改需输入你的定型承诺句(输入框禁粘贴;核对通过即保存,无需先解锁):',
            placeholder: '手动输入定型承诺句…',
            minLen: 10, noPaste: true, okLabel: '输入承诺并保存',
          }).then(function (v) {
            if (!v) return;
            checkKey(v).then(function (r) {
              if (r && r.ok && r.valid) {
                unlocked = true;
                unlockPhrase = v;
                if (r.adopt) sealPhrase = v;
                saveWith(null, '人格已保存', v);
              } else {
                toast((r && r.message) || '与定型时的承诺不一致,未保存,请重试');
              }
            }).catch(function () { toast('校验失败(网关不可达),未保存'); });
          });
        }

        function renderHist() {
          api('/persona/history').then(function (r) {
            histList.textContent = '';
            if (!r || !r.ok || !r.items || !r.items.length) {
              histList.appendChild(el('div', 'm-empty', '暂无历史 — 首次保存人格后自动留档'));
              return;
            }
            var shown = 0;
            r.items.slice(0, 10).forEach(function (it) {
              if (!it.ts) return;
              shown++;
              var rowEl2 = el('div', 'hr');
              var when = new Date(it.ts);
              function p2(x) { return x < 10 ? '0' + x : String(x); }
              var p = it.persona || {};
              var kindTag = it.kind === 'pre-rollback' ? '⏪ 回滚前 · ' : (it.kind === 'result' ? '' : '· ');
              var d = el('span', 'd', kindTag + (when.getMonth() + 1) + '-' + p2(when.getDate()) + ' ' + p2(when.getHours()) + ':' + p2(when.getMinutes()) +
                ' · 自称=' + ((p.aiName || '').split('/')[0] || '—') + ' · 规矩 ' + (Array.isArray(p.hardRules) ? p.hardRules.length : 0) +
                ' · 习惯 ' + (Array.isArray(p.habits) ? p.habits.length : 0) +
                ' 条 · 底线 ' + (Array.isArray(p.bottomLines) ? p.bottomLines.length : 0) + ' 条' + (p.sealed ? ' · 锁' : ''));
              var rb = el('button', null, '回滚');
              rb.onclick = function () {
                if (sealedNow && !unlocked) { toast('档案已定型 — 请先「对人格做手术」(输入承诺句)再回滚'); return; }
                if (!window.confirm('回滚到这份档案?\n将整体恢复为该次保存(或回滚前存档)的状态,含定型状态;当前状态会先自动另存一份,可再反悔。')) return;
                rb.disabled = true;
                api('/persona/rollback', { method: 'POST', body: { ts: it.ts, unlock: unlockPhrase || undefined } }).then(function (rr) {
                  rb.disabled = false;
                  if (rr && rr.ok) {
                    renderHist();
                    refill(true);
                    toast('已回滚到 ' + when.toLocaleString());
                  } else {
                    toast('回滚失败:' + ((rr && (rr.message || rr.reason)) || '未知'));
                    if (rr && rr.reason === 'sealed') { unlocked = false; applyLockUI(); }
                  }
                }).catch(function () { rb.disabled = false; toast('回滚失败(网关)'); });
              };
              rowEl2.appendChild(d);
              rowEl2.appendChild(rb);
              histList.appendChild(rowEl2);
            });
            if (!shown) histList.appendChild(el('div', 'm-empty', '暂无历史'));
          }).catch(function () { histList.textContent = '历史加载失败(网关)'; });
        }

        // 回填服务端现值;keepSession=true 时保留本次解锁状态
        /** 习惯是只读的:她长出来 → 双方确认后落地;面板不留"直接写"的入口。
         *  删改属"对她做手术":先解锁(承诺句),解锁后此处才出现「删掉」。 */
        function renderHabits(p) {
          var box = refs.habitsBox;
          if (!box) return;
          box.textContent = '';
          var list = Array.isArray(p.habits) ? p.habits : [];
          if (!list.length) {
            box.appendChild(el('div', 'm-empty', she('还没有习惯 —— 她长出来的候选会先出现在「建议中心」,你点头之后才会成为习惯。')));
            return;
          }
          list.forEach(function (h, hi) {
            var row = el('div', null);
            row.style.cssText = 'padding:7px 0;' + (hi < list.length - 1 ? 'border-bottom:1px solid var(--lg-border-soft);' : '');
            // 像 L1 那样只写一行:来源与依据在「建议中心」看一次就够,这里不重复
            var when = h.at ? String(new Date(Number(h.at)).toISOString()).slice(0, 10) : '';
            row.appendChild(el('div', null, (when ? '(' + when + ') ' : '') + String(h.text || '')));
            if (unlocked) { // 解锁(手术)状态下才允许改动:把删改纳入同一道门
              var br = el('div', 'btnrow');
              var del = el('button', null, '删掉');
              del.onclick = function () {
                del.disabled = true;
                api('/persona/habit', { method: 'POST', body: { action: 'remove', habit: h.text, unlock: unlockPhrase } }).then(function (x) {
                  if (x && x.ok) { toast('已删掉这条习惯'); refill(true); }
                  else { del.disabled = false; toast((x && x.message) ? String(x.message).slice(0, 70) : '删除失败'); }
                }).catch(function () { del.disabled = false; toast('网关不可达'); });
              };
              br.appendChild(del);
              row.appendChild(br);
            }
            box.appendChild(row);
          });
          var pend = Array.isArray(p.habitsPending) ? p.habitsPending.length : 0;
          if (pend) box.appendChild(el('div', 'm-meta', '(' + pend + ' 条待确认 —— 到「建议中心」点头才生效)'));
          // (2026-09-16 用户)不再解释"改动需做手术":这一栏是只读的,读者自然明白。
        }

        function refill(keepSession) {
          api('/state?scope=global').then(function (r) {
            if (!r || !r.ok || !r.persona) return;
            var p = r.persona;
            lastP = p;
            enabledBox.checked = p.enabled !== false;
            refs.userTitle.value = p.userTitle || '';
            refs.aiName.value = p.aiName || '';
            var pn = p.pronoun || '她';
            if (['她', '他', 'TA', '它'].indexOf(pn) >= 0) {
              pronounSel.value = pn; pronounInput.value = ''; pronounInput.style.display = 'none';
            } else {
              pronounSel.value = '__custom__'; pronounInput.value = pn; pronounInput.style.display = '';
            }
            refs.aiTitle.value = p.aiTitle || '';
            toneSel.value = p.tone || 'natural';
            toneWorkSel.value = p.toneWork || '';
            toneLifeSel.value = p.toneLife || '';
            langSel.value = p.language || 'follow';
            refs.hardRules.value = (p.hardRules || []).join('\n');
            renderHabits(p);
            refs.bottomLines.value = (p.bottomLines || []).join('\n');
            refs.extraLore.value = p.extraLore || '';
            refs.stylesWork.value = p.stylesWork || '';
            refs.stylesLife.value = p.stylesLife || '';
            // AI 起草按钮带上名字(每次点击都会真调模型,基于当前档案现场生成)
            if (draftBtn) {
              var who = coreName(p.aiName);
              draftBtn.textContent = who === '器灵' ? '✨ AI 起草定位自述' : ('✨ 让 ' + who + ' 自我总结/评价自述');
            }
            var wasSealed = sealedNow;
            sealedNow = p.sealed === true;
            sealPhrase = p.sealPhrase || '';
            if (!keepSession || (sealedNow && !wasSealed)) { unlocked = false; unlockPhrase = ''; }
            blCount();
            applyLockUI();
            renderHist();
            firePreview();
          }).catch(function () { /* 状态不可达时保持表单现状 */ });
        }

        var inputs = [enabledBox, toneSel, toneWorkSel, toneLifeSel, langSel, refs.userTitle, refs.aiName, refs.aiTitle, refs.hardRules, refs.bottomLines, refs.extraLore, refs.stylesWork, refs.stylesLife];
        inputs.forEach(function (n) {
          if (n.addEventListener) n.addEventListener('input', function () { schedulePreview(); blCount(); });
        });

        saveBtn.onclick = trySave;
        closeBtn.onclick = closeOverlays;
        refill(false);
      }

      function openMenuNear(rect, store) {
        ensureStyle();
        closeOverlays();
        var m = el('div', 'dsh-ling-menu');
        m.dataset.dark = dark();
        var left = rect ? rect.left : window.innerWidth / 2 - 100;
        var top = rect ? rect.bottom + 6 : 60;
        m.style.left = Math.max(6, Math.min(left, window.innerWidth - 220)) + 'px';
        m.style.top = Math.max(6, Math.min(top, window.innerHeight - 230)) + 'px';
        var st = store.get();
        var mode = st.mode || 'life';
        var items = [
          ['记忆中心(浏览/置顶/导入导出)', openMemoryCenter],
          ['人格中心(自称/语气/规矩·习惯·底线·定型)', openPersonaEditor],
          ['建议中心(语料提炼+点踩成长)', openFeedbackPanel],
          ['🌱 一键进入复盘', function () { startReviewFromMenu(); }, '与器灵互相复盘总结纠正:复制复盘开场白 + 解锁编辑 + 打开右侧复盘栏'],
          ['刷新记忆快照', function () { refreshMemory(store); }],
          ['状态 / L0·L1 现状', function () { openPanel(store); }],
        ];
        items.forEach(function (it) {
          var d = el('div', 'mi', it[0]);
          if (it[2]) d.title = it[2]; // 第三元素 = 悬浮说明(2026-09-22)
          d.onclick = function () { closeOverlays(); it[1](); };
          m.appendChild(d);
        });
        m.appendChild(el('div', 'sep'));
        m.appendChild(el('div', 'hint', st.kind === 'global' ? '无会话时管理全局默认(D2);新会话自动跟随' : 'D4 冻结:运行中的会话不应用任何人格/记忆更新'));
        // 先隐藏渲染量尺寸,再定方位(下方放不下自动向上翻,水平夹紧)
        m.style.visibility = 'hidden';
        document.body.appendChild(m);
        var mw = m.offsetWidth;
        var mh = m.offsetHeight;
        var gap = 8;
        var anchor = rect || { left: Math.round((window.innerWidth - mw) / 2), top: Math.round(window.innerHeight / 2), bottom: Math.round(window.innerHeight / 2) };
        var spaceBelow = window.innerHeight - anchor.bottom;
        var spaceAbove = anchor.top;
        var top;
        if (spaceBelow >= mh + gap || spaceBelow >= spaceAbove) top = anchor.bottom + gap;
        else top = Math.max(6, anchor.top - mh - gap);
        var left = Math.max(6, Math.min(anchor.left, window.innerWidth - mw - 6));
        m.style.left = left + 'px';
        m.style.top = top + 'px';
        if (top + mh > window.innerHeight - 4) {
          m.style.maxHeight = Math.max(180, window.innerHeight - top - 8) + 'px';
          m.style.overflowY = 'auto';
        }
        m.style.visibility = '';
        armOverlays();
      }

      // ---------------- 记忆中心(浏览/置顶/删除/导入导出) ----------------
      function openMemoryCenter() {
        ensureStyle();
        closeOverlays();
        var st = {
          tab: 'overview', source: '', branch: '', category: '', sort: 'updated', q: '',
          items: [], total: 0, offset: 0, expanded: {},
          // D9-b 记忆树:treeData = /tree 原始返回;collapsed = 折叠状态;treeSel = 选中枝;conflicts = 矛盾列表
          // reviewMode = 复盘模式(设计稿 §3.3):平时树结构只读,进复盘才解锁改名/并脉/权重/连边
          treeData: null, collapsed: {}, treeSel: '', conflicts: null, reviewMode: false, reviewLog: null,
          // 审计 C#15(双真值):原先 treeSel(主选中)+ treeMulti(Ctrl 多选集)**各自独立**,
          // 两边都存"这一行被选中了"⇒ 两个真值、颜色两套。现在只有 treeSel 是**单选真值**,
          // extraSel 只是"额外 Ctrl 选中的行"(不含主选中),选中的判定统一为
          //   sel  = (n.id === treeSel) || extraSel 里有 n.id
          // —— 与侧栏复盘栏同思路(那里 selId 由 dragIds 派生,单选多选共用一个真值)。
          extraSel: [],
          // 一键生成记忆树(autotree):autoOpen=面板开关;autoData=preview 原始返回;
          // autoNames=bucketId→名字(可手改);autoBusy=防重入(命名/应用期间禁用按钮)
          autoOpen: false, autoData: null, autoNames: {}, autoBusy: false, autoExpand: {},
        };
        // 注册同步钩子供模块级"一键进入复盘"使用(见 lingCenterSync 注释)
        lingCenterSync = function (td, conf) {
          st.treeData = td;
          st.conflicts = conf;
          // 数据一律同步(切回「记忆树」标签时要用),但**只在记忆树标签下才重绘** ——
          // 否则会把主人正在看的「概览/浏览/接入历史」内容顶掉(与 C#8 同一个坑)。
          if (st.tab === 'tree') {
            try { paintTree(); } catch (e) { console.warn('[dsh-ling] 记忆树重绘失败', e); }
          }
        };
        // 侧栏操作完成后调它 → 记忆中心重新拉数据,保证两侧显示一致(2026-09-22)
        lingCenterReload = function () {
          // 审计 C#8:必须有 st.tab 守卫 —— loadTreeAll() 会先清空 body 再画**记忆树**,
          // 侧栏里任何一次操作(改归属/连边/存快照)都会把主人正在看的「概览/浏览/接入历史」
          // 悄悄换成记忆树,而顶部标签高亮还停在原来那个 ⇒ 内容与标签不符。
          // 只有主人**正停在「记忆树」标签**时才重载(paintTree 只在 tree 标签下才是"当前视图")。
          if (st.tab !== 'tree') return;
          st.treeData = null;
          st.conflicts = null;
          try { loadTreeAll(); } catch (e) { console.warn('[dsh-ling] 记忆中心重载失败', e); }
        };
        var wrap = el('div', 'dsh-ling-panel ling-mc');
        // 审计 C#9(记忆中心侧):面板关闭后模块级钩子必须置空 —— 否则它们一直闭包着本面板的
        // st / body / DOM 节点(陈旧闭包),下一次「一键进入复盘」会往已销毁的 DOM 上写东西。
        // ⚠ 注意:initPanelDrag() 已经往同一个节点上装过 __lingCleanup(卸载拖动监听),
        //   所以这里是**链式追加**而不是覆盖 —— 直接赋值会把拖动监听的清理顶掉。
        var prevCleanup = wrap.__lingCleanup;
        wrap.__lingCleanup = function () {
          if (typeof prevCleanup === 'function') { try { prevCleanup(); } catch (e) { console.warn('[dsh-ling] 面板清理失败', e); } }
          lingCenterSync = null;
          lingCenterReload = null;
        };
        // Ctrl+Z 撤回上一步(拖动/连边):监听挂在面板上 —— 随面板销毁自动清理,不会累积 document 级监听。
        wrap.tabIndex = 0;
        wrap.style.outline = 'none';
        wrap.addEventListener('keydown', function (ev) {
          if ((ev.ctrlKey || ev.metaKey) && String(ev.key).toLowerCase() === 'z') {
            if (undoLastDrop()) { ev.preventDefault(); ev.stopPropagation(); }
          }
        });
        wrap.dataset.dark = dark();
        var head = el('h3', null, '记忆中心');
        head.appendChild(el('div', 'hint', '历史会话与 DSH 会话的记忆库:浏览、置顶(提升 L1 权重)、删除、导入导出'));
        wrap.appendChild(head);

        var tabs = el('div', 'ling-tabs');
        var tabOverview = el('div', 'ling-tab on', '概览与数据');
        var tabBrowse = el('div', 'ling-tab', '记忆浏览');
        var tabAccess = el('div', 'ling-tab', '接入历史');
        var tabTree = el('div', 'ling-tab', '记忆树');
        tabs.appendChild(tabOverview);
        tabs.appendChild(tabBrowse);
        tabs.appendChild(tabAccess);
        tabs.appendChild(tabTree);
        wrap.appendChild(tabs);

        var body = el('div', 'mc-body');
        wrap.appendChild(body);

        var foot = el('div', 'btnrow');
        var close = el('button', null, '关闭');
        foot.appendChild(close);
        wrap.appendChild(foot);
        document.body.appendChild(wrap);
        armOverlays();
        initPanelDrag(wrap, 'mc');
        close.onclick = closeOverlays;

        function switchTab(name) {
          st.tab = name;
          tabOverview.className = 'ling-tab' + (name === 'overview' ? ' on' : '');
          tabBrowse.className = 'ling-tab' + (name === 'browse' ? ' on' : '');
          tabAccess.className = 'ling-tab' + (name === 'access' ? ' on' : '');
          tabTree.className = 'ling-tab' + (name === 'tree' ? ' on' : '');
          render();
        }
        tabOverview.onclick = function () { switchTab('overview'); };
        tabBrowse.onclick = function () { switchTab('browse'); };
        tabAccess.onclick = function () { switchTab('access'); };
        tabTree.onclick = function () { switchTab('tree'); };

        function renderOverview() {
          body.textContent = '';
          body.appendChild(el('div', 'kv', '加载器灵概览…'));
          var g = el('div', null);
          var TONE = { natural: '自然亲切', literary: '文雅', concise: '简洁直接', playful: '活泼俏皮' };
          var LANG = { follow: '跟随用户', zh: '中文', en: 'English' };
          var counts = {};
          var meta = {};
          function qOne(key, url) {
            return api('/memories?limit=1' + (url || '')).then(function (r) {
              counts[key] = r && r.total != null ? r.total : 0;
            }).catch(function () { counts[key] = 0; });
          }
          function stat(label, n) {
            var s = el('div', 'stat');
            s.appendChild(el('b', null, String(n)));
            s.appendChild(el('span', null, label));
            return s;
          }
          Promise.all([
            qOne('all', ''), qOne('k', '&category=knowledge'), qOne('d', '&category=daily'), qOne('f', '&category=feeling'),
            qOne('w', '&source=dsweb'), qOne('dsh', '&source=dsh'), qOne('imp', '&source=import'),
            api('/state?scope=global&l0Preview=1').then(function (r) { meta.state = r; }),
            api('/suggestions').then(function (r) { meta.sugg = r; }),
            api('/feedback').then(function (r) { meta.fb = r; }),
            api('/deep/status').then(function (r) { meta.deep = r; }),
          ]).then(function () {
            body.textContent = '';
            var st8 = meta.state || {};
            var per = st8.persona || {};
            var head = el('div', 'spirit-head');
            function chip(txt) { return el('span', 'm-chip', txt); }
            head.appendChild(chip('自称 ' + (per.aiName || '—')));
            head.appendChild(chip('称呼 ' + (per.userTitle || '—')));
            head.appendChild(chip('语气 ' + (TONE[per.tone] || per.tone || '—')));
            head.appendChild(chip('语言 ' + (LANG[per.language] || per.language || '—')));
            var rules = (per.hardRules || []).length;
            var habits = (per.habits || []).length;
            if (rules) head.appendChild(chip('规矩 ' + rules + ' 条'));
            if (habits) head.appendChild(chip('习惯 ' + habits + ' 条'));
            var bots = (per.bottomLines || []).length;
            if (bots) head.appendChild(chip('底线 ' + bots + ' 条'));
            if (per.sealed) head.appendChild(chip('🔒已定型'));
            head.appendChild(chip('当前默认模式 ' + (st8.lastMode === 'work' ? '工作' : '生活')));
            g.appendChild(head);
            var l0Row = el('div', 'm-acts');
            l0Row.appendChild(el('span', 'm-meta', 'L0 只读预览'));
            var bEdit = el('button', 'primary', '✎ 人格中心');
            bEdit.onclick = openPersonaEditor;
            l0Row.appendChild(bEdit);
            g.appendChild(l0Row);
            var l0 = el('div', 'ling-preview', (st8.l0PreviewText || '(L0 为空 — 人格开关关闭时仅注入最小身份段)'));
            l0.style.maxHeight = '150px';
            g.appendChild(l0);
            var grid = el('div', 'stat-grid');
            grid.appendChild(stat('概述总数', counts.all || 0));
            grid.appendChild(stat('历史网页端', counts.w || 0));
            grid.appendChild(stat('DSH 会话', counts.dsh || 0));
            grid.appendChild(stat('文件导入', counts.imp || 0));
            grid.appendChild(stat('知识', counts.k || 0));
            grid.appendChild(stat('日常', counts.d || 0));
            grid.appendChild(stat('生活', counts.f || 0));
            grid.appendChild(stat('待确认语料建议', (meta.sugg && meta.sugg.stats ? meta.sugg.stats.new : 0)));
            grid.appendChild(stat('已深摘', (meta.deep && meta.deep.done != null ? meta.deep.done : '?')));
            g.appendChild(grid);
            var line = el('div', 'spirit-note', [
              'L1 记忆:每次新会话开场按模式加权加载 Top-K 概述(置顶条目权重更高);可到「记忆浏览」置顶/删除/深摘。',
              meta.fb && meta.fb.stats && meta.fb.stats.new ? ('点踩待确认 ' + meta.fb.stats.new + ' 条,可在「建议中心」处理。') : '',
            ].filter(Boolean).join('\n'));
            g.appendChild(line);
            var acts = el('div', 'panel-actions');
            var bExp = el('button', 'primary', '⬇ 导出记忆包');
            bExp.onclick = exportMemory;
            var bImp = el('button', null, '⬆ 导入记忆包…');
            var fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = '.json,.dshling.json,application/json';
            fileInput.style.display = 'none';
            fileInput.onchange = function () {
              var f = fileInput.files && fileInput.files[0];
              if (!f) return;
              var reader = new FileReader();
              reader.onload = function () {
                try {
                  var bundle = JSON.parse(String(reader.result));
                  var applyPersona = window.confirm('该包包含人格/风格设置。\n\n确定 = 同时覆盖本机人格与风格(备份恢复用)\n取消 = 只并入记忆/建议/队列,人格保持现状');
                  var payload = applyPersona ? { bundle: bundle, persona: true } : { bundle: bundle };
                  api('/import', { method: 'POST', body: payload }).then(function (r) {
                    if (r && r.ok) {
                      var rp = r.report || {};
                      toast('导入完成:概述新增 ' + rp.added + ' · 跳过 ' + rp.skipped + ' · 覆盖 ' + rp.overwritten +
                        (rp.queueAdded ? ' · 反馈 ' + rp.queueAdded : '') +
                        (rp.suggAdded ? ' · 建议 ' + rp.suggAdded : '') +
                        (rp.deepRestored ? ' · 深摘恢复 ' + rp.deepRestored : '') +
                        (r.personaApplied ? ' · 人格已覆盖' : ''));
                    } else if (r && r.reason === 'sealed') {
                      toast('导入失败:人格已定型 — 请先到「人格中心」做手术(输入承诺句)后再覆盖导入;仅导入记忆不受影响');
                    } else toast('导入失败:' + JSON.stringify(r || {}).slice(0, 120));
                    if (st.tab === 'overview') renderOverview();
                  }).catch(function () { toast('导入失败(网关不可达)'); });
                } catch (e) {
                  toast('文件不是有效的记忆包 JSON');
                }
              };
              reader.readAsText(f);
              fileInput.value = '';
            };
            bImp.onclick = function () { fileInput.click(); };
            var bPer = el('button', null, '✎ 人格中心');
            bPer.onclick = openPersonaEditor;
            var bFb = el('button', null, '建议中心');
            bFb.onclick = openFeedbackPanel;
            var bDeep = el('button', null, '深度摘要');
            bDeep.onclick = function () {
              bDeep.disabled = true;
              bDeep.textContent = '摘要中…';
              api('/deep/run', { method: 'POST', body: {} }).then(function (r) {
                bDeep.disabled = false;
                bDeep.textContent = '深度摘要';
                if (r && r.ok) {
                  var okN = (r.done || []).filter(function (d) { return d.ok; }).length;
                  toast('深摘要完成:' + okN + '/' + (r.done || []).length + ' 个会话' + (r.candidates > okN ? '(其余候选达标但未达输出或已在队列)' : ''));
                } else {
                  toast('深摘要不可用:' + ((r && r.reason) || '').slice(0, 120));
                }
              }).catch(function () { bDeep.disabled = false; bDeep.textContent = '深度摘要'; toast('调用失败(网关)'); });
            };
            acts.appendChild(bExp);
            acts.appendChild(bImp);
            acts.appendChild(bPer);
            acts.appendChild(bFb);
            acts.appendChild(bDeep);
            g.appendChild(fileInput);
            g.appendChild(acts);
            // 网页端历史库增量扫描(源:ds-search 生成的 deepseek_library.db)
            var scanZone = el('div', 'scan-zone');
            scanZone.style.cssText = 'margin-top:10px;padding:10px 12px;border:1px dashed var(--lg-border);border-radius:11px;';
            var scanHead = el('div', 'm-meta');
            scanHead.style.cssText = 'font-weight:700;opacity:.9;margin-bottom:6px;';
            scanHead.textContent = '网页端历史增量扫描(ds-search 库)';
            var pathWrap = el('div', null);
            pathWrap.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;';
            var pathInput = document.createElement('input');
            pathInput.type = 'text';
            pathInput.style.cssText = 'flex:1;min-width:220px;padding:6px 10px;border:1px solid var(--lg-input);border-radius:9px;background:transparent;color:var(--lg-text);font-size:13px;';
            var savedPath = '';
            try { savedPath = sessionStorage.getItem('dsh-ling-dsweb-db') || ''; } catch (e) {}
            pathInput.value = savedPath;
            pathInput.placeholder = '聊天记录库文件(.db)的完整路径,例如 …/deepseek_library.db';
            var bScan = el('button', null, '扫描并增量入库');
            bScan.type = 'button';
            var scanRes = el('div', 'm-meta', '');
            scanRes.style.cssText = 'width:100%;margin-top:6px;';
            bScan.onclick = function () {
              bScan.disabled = true;
              var old = bScan.textContent;
              bScan.textContent = '扫描中…';
              scanRes.textContent = '';
              try { sessionStorage.setItem('dsh-ling-dsweb-db', pathInput.value.trim()); } catch (e) {}
              api('/dsweb/scan', { method: 'POST', body: { db: pathInput.value.trim() } }).then(function (r) {
                bScan.disabled = false;
                bScan.textContent = old;
                if (r && r.ok) {
                  var msg = '源库 ' + r.seen + ' 条:新增 ' + r.added + ' · 元数据刷新 ' + r.refreshed + ' · 库内 dsweb 共 ' + r.total + ' 条';
                  scanRes.textContent = '✓ ' + msg;
                  toast('网页端历史扫描完成:' + msg);
                  if (st.tab === 'overview') renderOverview();
                } else {
                  scanRes.textContent = '✗ ' + ((r && r.message) || JSON.stringify(r || {}).slice(0, 160));
                }
              }).catch(function () {
                bScan.disabled = false;
                bScan.textContent = old;
                scanRes.textContent = '✗ 扫描失败(网关不可达)';
              });
            };
            pathWrap.appendChild(pathInput);
            pathWrap.appendChild(bScan);
            scanZone.appendChild(scanHead);
            scanZone.appendChild(pathWrap);
            scanZone.appendChild(scanRes);
            g.appendChild(scanZone);
            // 网页端历史「补摘要」:候选预览 + 双引擎 + 进度(CLI 之外的图形入口)
            // 纪律:引擎选择是**显式动作** —— 小助手探测失败只提示,不静默改用大模型(那等于替用户花钱)。
            var sumZone = el('div', 'scan-zone');
            sumZone.style.cssText = 'margin-top:10px;padding:10px 12px;border:1px dashed var(--lg-border);border-radius:11px;';
            var sumHead = el('div', 'm-meta');
            sumHead.style.cssText = 'font-weight:700;opacity:.9;margin-bottom:6px;';
            sumHead.textContent = '为历史会话补摘要(只补"没有摘要"的行)';
            var sumWrap = el('div', null);
            sumWrap.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;';
            var sumDb = document.createElement('input');
            sumDb.type = 'text';
            sumDb.style.cssText = 'flex:1;min-width:200px;padding:6px 10px;border:1px solid var(--lg-input);border-radius:9px;background:transparent;color:var(--lg-text);font-size:13px;';
            sumDb.value = savedPath;
            sumDb.placeholder = '同上:聊天记录库(.db)路径(可留空 = 用扫描那栏填的路径)';
            var sumEng = makeSel([
              { v: 'assistant', l: '本机小助手(零成本)' },
              { v: 'global', l: '当前全局大模型(会花额度)' },
            ], 'assistant', function () {});
            var bSumPrev = el('button', null, '预览候选');
            bSumPrev.type = 'button';
            var bSumRun = el('button', null, '开始补摘要');
            bSumRun.type = 'button';
            var sumRes = el('div', 'm-meta', '');
            sumRes.style.cssText = 'width:100%;margin-top:6px;white-space:pre-wrap;line-height:1.7;max-height:200px;overflow:auto;';
            var sumTimer = null;
            function sumDbPath() {
              var v = (sumDb.value || '').trim() || (pathInput.value || '').trim();
              try { if (v) sessionStorage.setItem('dsh-ling-dsweb-db', v); } catch (e) {}
              return v;
            }
            function sumStatus() {
              api('/dsweb/summary/status').then(function (r) {
                if (!r || !r.ok) return;
                if (r.running) {
                  sumRes.textContent = '补摘要中… ' + r.finished + '/' + r.total +
                    (r.current ? '(' + r.current + ')' : '') + ' · 成功 ' + r.okCount + ' · 失败 ' + r.failCount;
                  bSumRun.disabled = true;
                  if (!sumTimer) sumTimer = setInterval(sumStatus, 2000);
                  return;
                }
                if (sumTimer) { clearInterval(sumTimer); sumTimer = null; }
                bSumRun.disabled = false;
                if (r.total) {
                  sumRes.textContent = '✓ 补摘要完成:成功 ' + r.okCount + ' · 失败 ' + r.failCount +
                    ' · 共 ' + r.total + (r.lastError ? ' · 最后错误:' + r.lastError : '') +
                    '\n(长会话会在下次空闲时自动追平这批新摘要)';
                }
              }).catch(function () {});
            }
            bSumPrev.onclick = function () {
              var db = sumDbPath();
              if (!db) { sumRes.textContent = '✗ 还没填聊天记录库路径 —— 可在本卡片填写,或先在上方「网页端历史增量扫描」栏填一次(那栏的路径会被复用)'; return; }
              bSumPrev.disabled = true;
              sumRes.textContent = '读取候选…';
              api('/dsweb/summary/preview?db=' + encodeURIComponent(db) + '&limit=15').then(function (r) {
                bSumPrev.disabled = false;
                if (!r || !r.ok) { sumRes.textContent = '✗ ' + ((r && r.message) || '读取失败'); return; }
                var lines = ['候选 ' + r.total + ' 条(轮次 ≥' + r.minTurns + ')· 小助手:' +
                  (r.assistant && r.assistant.ok ? '在线(' + (r.assistant.models || []).join('/') + ')' : '未探测到(' + ((r.assistant && r.assistant.reason) || '?') + ')')];
                (r.items || []).forEach(function (it) {
                  lines.push('  · ' + String(it.title || it.conv_id).slice(0, 34) + ' · ' + it.n_user + ' 轮' + (it.hit_count ? ' · 命中 ' + it.hit_count : ''));
                });
                if (r.total > (r.items || []).length) lines.push('  … 仅列前 ' + (r.items || []).length + ' 条');
                sumRes.textContent = lines.join('\n');
              }).catch(function () { bSumPrev.disabled = false; sumRes.textContent = '✗ 读取失败(网关)'; });
            };
            bSumRun.onclick = function () {
              var db = sumDbPath();
              if (!db) { sumRes.textContent = '✗ 还没填聊天记录库路径 —— 可在本卡片填写,或先在上方「网页端历史增量扫描」栏填一次(那栏的路径会被复用)'; return; }
              bSumRun.disabled = true;
              sumRes.textContent = '启动…';
              api('/dsweb/summary/run', { method: 'POST', body: { db: db, engine: sumEng.value } }).then(function (r) {
                if (!r || !r.ok) {
                  bSumRun.disabled = false;
                  sumRes.textContent = '✗ ' + ((r && r.message) || '启动失败');
                  return;
                }
                if (r.busy) { sumRes.textContent = '已有一轮在跑,附上进度…'; }
                sumStatus();
                if (!sumTimer) sumTimer = setInterval(sumStatus, 2000);
              }).catch(function () { bSumRun.disabled = false; sumRes.textContent = '✗ 启动失败(网关)'; });
            };
            sumWrap.appendChild(sumDb);
            sumWrap.appendChild(sumEng.node);
            sumWrap.appendChild(bSumPrev);
            sumWrap.appendChild(bSumRun);
            sumZone.appendChild(sumHead);
            sumZone.appendChild(sumWrap);
            sumZone.appendChild(sumRes);
            g.appendChild(sumZone);
            sumStatus();
            body.appendChild(g);
          });
        }

        // D8(2026-09-17):先取各来源条数,筛选栏直接显示「历史网页端 (1523)」——
        // 否则 95% 的库(dsweb 1523/1599)在默认视图里沉底,主人无从知道库里到底有什么。
        function renderBrowse() {
          body.textContent = '';
          body.appendChild(el('div', 'm-empty', '加载中…'));
          api('/memories/sources').then(function (sc) {
            body.textContent = '';
            renderBrowseInner(sc && sc.ok ? sc : null);
          }).catch(function () {
            body.textContent = '';
            renderBrowseInner(null);
          });
        }

        function renderBrowseInner(counts) {
          var tools = el('div', 'm-tools');
          function selChange(apply) {
            return function (v) { apply(v); run(); };
          }
          function cnt(v, base) {
            if (!counts) return base;
            var n = v ? (counts.bySource || {})[v] : counts.total;
            return n == null ? base : base + ' (' + n + ')';
          }
          var sSource = makeSel([
            { v: '', l: cnt('', '全部来源') }, { v: 'dsweb', l: cnt('dsweb', '历史网页端') },
            { v: 'dsh', l: cnt('dsh', 'DSH 会话') }, { v: 'import', l: cnt('import', '文件导入') },
            { v: 'vein', l: cnt('vein', '主脉提炼') },
          ], st.source, selChange(function (v) { st.source = v; st.offset = 0; }));
          // D9-a 记忆分枝:枝下拉。主干常驻首位,其余枝按记忆数排。
          var branchList = counts && counts.branch && counts.branch.list ? counts.branch.list : [];
          var branchOpts = [{ v: '', l: counts && counts.branch ? '全部枝 (' + (counts.branch.total || 0) + ')' : '全部枝' }];
          for (var bi = 0; bi < branchList.length; bi++) {
            var bb = branchList[bi];
            branchOpts.push({ v: bb.id, l: (bb.name || bb.id) + ' (' + (bb.memories || 0) + ')' });
          }
          var sBranch = makeSel(branchOpts, st.branch, selChange(function (v) { st.branch = v; st.offset = 0; }));
          var sCat = makeSel([
            { v: '', l: '全部分类' }, { v: 'knowledge', l: '知识' }, { v: 'daily', l: '日常' }, { v: 'feeling', l: '生活' },
          ], st.category, selChange(function (v) { st.category = v; st.offset = 0; }));
          var sSort = makeSel([
            { v: 'updated', l: '最近活跃' }, { v: 'heat', l: '热度' }, { v: 'created', l: '创建时间' },
          ], st.sort, selChange(function (v) { st.sort = v; st.offset = 0; }));
          var search = document.createElement('input');
          search.type = 'search';
          search.placeholder = '搜索标题/摘要/关键词…';
          search.value = st.q;
          var reload = el('button', null, '查询');
          var totalLbl = el('span', null, '');
          totalLbl.style.cssText = 'opacity:.6;font-size:12px;';
          tools.appendChild(sSource.node);
          tools.appendChild(sBranch.node);
          tools.appendChild(sCat.node);
          tools.appendChild(sSort.node);
          tools.appendChild(search);
          tools.appendChild(reload);
          tools.appendChild(totalLbl);
          body.appendChild(tools);

          var list = el('div', null);
          body.appendChild(list);
          var sentinel = el('div', 'm-empty', '');
          sentinel.style.cssText = 'padding:10px;text-align:center;opacity:.55;font-size:12.5px;';
          body.appendChild(sentinel);

          var qTimer = null;
          var busy = false;
          function run() {
            if (qTimer) clearTimeout(qTimer);
            qTimer = setTimeout(function () { load(true); }, 320);
          }
          reload.onclick = function () { load(true); };
          search.oninput = function () { st.q = search.value; run(); };
          search.onkeydown = function (e) { if (e.key === 'Enter') load(true); };

          function qsParts() {
            return (st.source ? '&source=' + st.source : '') +
              (st.branch ? '&branch=' + encodeURIComponent(st.branch) : '') +
              (st.category ? '&category=' + st.category : '') +
              '&sort=' + st.sort +
              (st.q ? '&q=' + encodeURIComponent(st.q) : '');
          }

          // reset=true 从首页重载;否则按已显示条数续页(继续下滑加载更早)
          function load(reset) {
            if (busy) return;
            busy = true;
            if (reset) {
              st.items = [];
              st.offset = 0;
              list.textContent = '';
              sentinel.textContent = '加载中…';
            } else {
              sentinel.textContent = '加载更早的记忆…';
            }
            api('/memories?limit=80&offset=' + st.offset + qsParts()).then(function (r) {
              busy = false;
              if (!r || !r.ok) {
                sentinel.textContent = '加载失败 — 点击重试';
                sentinel.onclick = function () { sentinel.onclick = null; load(reset); };
                return;
              }
              sentinel.onclick = null;
              var got = r.items || [];
              st.total = r.total || 0;
              if (!got.length && !st.items.length) {
                totalLbl.textContent = '共 0 条';
                sentinel.textContent = '';
                list.appendChild(el('div', 'm-empty', '没有匹配的记忆。'));
                return;
              }
              got.forEach(function (it) { list.appendChild(rowEl(it)); });
              st.items = st.items.concat(got);
              st.offset = st.items.length;
              totalLbl.textContent = '共 ' + st.total + ' 条 · 已显示 ' + st.items.length;
              sentinel.textContent = st.items.length >= st.total && st.total > 0 ? '— 已到最早 —' : '';
            }).catch(function () {
              busy = false;
              sentinel.textContent = '加载失败(网关不可达)';
            });
          }
          // 滚动容器是 mc-body(即本函数里的 body):接近底部自动续页
          function onBrowseScroll() {
            if (busy) return;
            var c = body;
            if (!c.scrollHeight || st.total <= st.items.length) return;
            if (c.scrollTop + c.clientHeight >= c.scrollHeight - 170) load(false);
          }
          if (body.__lingScroll) body.removeEventListener('scroll', body.__lingScroll);
          body.__lingScroll = onBrowseScroll;
          body.addEventListener('scroll', body.__lingScroll);

          // D2:这把锁锁住的是**自动重写**,不是主人 —— 悬浮说明避免新用户误以为"锁住了用户"。
          // 2026-09-17 用户定稿(标题层的总基调):
          //   ① 三条定名路径(主人手改 / 模型自动 / 来历未记录)**不制造等级感** ——
          //      看到的是同一个「已定名」,分类只藏在水下(仅服务于悬浮说明);
          //   ② 不用「暂定」二字:人对一段记忆的概括本就是暂定的(会随阅历改变),
          //      但界面要让人确认"它已经落了笔",故取「已定名」;
          //   ③ 用词不得写死"小助手" —— 起名可能走本机小助手、也可能回落当前全局大模型,
          //      没配小助手/多模型的环境里写死就是错话。
          // 更远的基调:标题层是器灵的"修枝剪叶"式自我复盘,器灵与主人同级;
          // 远期或可全交器灵,现阶段因经验与长程记忆规模仍保留人审(人审是安全阀,不是权限)。
          var LOCK_TIP = {
            user: '你起的名字。已定名,自动重写不会再覆盖;点击「改名」换成新的。',
            ai: '自动起的名字。已定名,自动重写不会再覆盖;点击「改名」换成你自己的。',
            legacy: '已定名(来历未记录),自动重写不会再覆盖;点击「改名」换成你自己的。',
          };
          function rowEl(it) {
            var card = el('div', 'm-row');
            var titleLine = el('div', 'm-title', it.title || '(无标题)');
            if (it.importance >= 1) titleLine.appendChild(el('span', 'm-chip', '📌置顶'));
            if (it.title_locked) {
              var who = it.title_by === 'ai' ? 'ai' : it.title_by === 'user' ? 'user' : 'legacy';
              // 三条路径同一个标记:定名者只在水下的悬浮说明里出现(见上面的总基调)
              var lockChip = el('span', 'm-chip', '🔒 已定名');
              lockChip.title = LOCK_TIP[who];
              lockChip.style.cursor = 'help';
              titleLine.appendChild(lockChip);
            }
            // 修 A:历史遗留的数字时间戳(如 "1789006881011.0")不能直接 slice,先归一
            var rawDate = String(it.updated_at || it.started_at || '');
            var date = /^\d+(?:\.\d+)?$/.test(rawDate)
              ? new Date(Number(rawDate)).toISOString().slice(0, 10)
              : rawDate.slice(0, 10);
            var metaTxt = (date ? date + ' · ' : '') +
              (it.category === 'knowledge' ? '知识' : it.category === 'feeling' ? '生活' : '日常') +
              ' · ' + (it.source === 'dsh' ? 'DSH 会话' : it.source === 'import' ? '文件导入' : '历史会话') +
              ' · 命中 ' + (it.hit_count || 0) + (it.origin ? ' · ' + it.origin : '');
            var meta = el('div', 'm-meta', metaTxt);
            var acts = el('div', 'm-acts');
            var bPin = el('button', it.importance >= 1 ? 'primary' : null, it.importance >= 1 ? '取消置顶' : '置顶');
            bPin.onclick = function () {
              api('/memories/pin', { method: 'POST', body: { source: it.source, conv_id: it.conv_id, pin: it.importance < 1 } }).then(function (r2) {
                if (r2 && r2.ok) toast('已' + (it.importance < 1 ? '置顶(提升 L1 权重)' : '取消置顶'));
                load(true);
              });
            };
            var bDel = el('button', null, '删除');
            bDel.onclick = function () {
              if (!window.confirm('删除这条记忆概述?' + (it.source === 'dsh' ? '\n(原始会话记录不受影响)' : ''))) return;
              api('/memories/delete', { method: 'POST', body: { source: it.source, conv_id: it.conv_id } }).then(function (r2) {
                if (r2 && r2.ok) { toast('已删除'); load(true); }
              });
            };
            var bDet = el('button', null, '详情');
            bDet.onclick = function () {
              var key = it.source + ':' + it.conv_id;
              var detail = card.querySelector('.m-detail');
              if (detail) { detail.remove(); return; }
              var d = el('div', 'm-detail', '');
              var lines = [];
              // 三段式:① 给人看的摘要(缺则说明原因)② 原文片段摘录 ③ 检索索引(系统用)
              if (it.summary && String(it.summary).trim()) {
                lines.push('摘要: ' + it.summary);
              } else {
                lines.push('摘要: (暂无 — 短会话属正常;达标的长会话将由深摘陆续补充)');
              }
              var kw = (it.keywords || []).filter(Boolean);
              if (kw.length) {
                var raw = kw.join('');
                lines.push('片段摘录(自动拼回原文,供快速浏览):');
                lines.push('  ' + (raw.length > 320 ? raw.slice(0, 320) + '…' : raw));
                var idxShow = kw.slice(0, 20).join(' / ');
                lines.push('检索索引(系统检索用,不必以人话读): ' + idxShow + (kw.length > 20 ? ' …' : ''));
              }
              lines.push('ID: ' + it.conv_id + ' · 类别:' + it.category + ' · 来源:' + it.origin);
              d.textContent = lines.join('\n');
              card.appendChild(d);
            };
            acts.appendChild(bPin);
            // D2(2026-09-17):标题是记忆的"名字" —— 主人可手改(改后上锁,机器不再覆盖),
            // 也可让小助手起名(本机零成本;原文/摘要作材料)。
            var bName = el('button', null, '改名');
            bName.onclick = function () {
              var next = window.prompt('给这条记忆起个名字(改名后机器不再覆盖):', it.title || '');
              if (next === null) return;
              var t = String(next).trim();
              if (!t) return;
              api('/memories/rename', { method: 'POST', body: { source: it.source, conv_id: it.conv_id, title: t } }).then(function (r2) {
                if (r2 && r2.ok) { toast('已改名并锁定'); load(true); }
                else toast('改名失败:' + ((r2 && r2.error) || '未知'));
              }).catch(function () { toast('改名失败(网关)'); });
            };
            var bAi = el('button', null, 'AI 起名');
            bAi.onclick = function () {
              bAi.disabled = true;
              bAi.textContent = '起名中…';
              api('/memories/retitle', { method: 'POST', body: { source: it.source, conv_id: it.conv_id } }).then(function (r2) {
                bAi.disabled = false;
                bAi.textContent = 'AI 起名';
                if (r2 && r2.ok) { toast('新名字:' + r2.title); load(true); }
                else toast('起名失败:' + ((r2 && (r2.error || r2.title)) || '未知'));
              }).catch(function () {
                bAi.disabled = false;
                bAi.textContent = 'AI 起名';
                toast('起名失败(网关)');
              });
            };
            acts.appendChild(bName);
            acts.appendChild(bAi);
            acts.appendChild(bDel);
            if (it.source === 'dsh') {
              var bDeep = el('button', null, '重摘');
              bDeep.onclick = function () {
                bDeep.disabled = true;
                api('/deep/one', { method: 'POST', body: { sessionId: it.conv_id } }).then(function (r2) {
                  bDeep.disabled = false;
                  if (r2 && r2.ok) toast('深摘要已更新(' + r2.chars + ' 字);点击详情查看');
                  else toast((r2 && r2.message) || '重摘失败:' + ((r2 && (r2.reason || r2.error)) || '未知'));
                  load(true);
                }).catch(function () { bDeep.disabled = false; toast('重摘失败(网关)'); });
              };
              acts.appendChild(bDeep);
            }
            acts.appendChild(bDet);
            card.appendChild(titleLine);
            card.appendChild(meta);
            card.appendChild(acts);
            return card;
          }

          load(true);
        }

        // ---------------- 记忆树 · 复盘(D9-b,2026-09-19) ----------------
        // 树形结构 + 复盘驱动的操作:并脉(归类) / 连边 / 调权重 / 矛盾裁定。
        // 「一键复盘」按用户定的设计约束(§10.1)把开场材料一次备齐 —— 复盘的门槛必须接近 0,
        // 否则它会像"整理房间"一样被无限推迟。树的任何操作都**不改写记忆内容**。
        var TREE_KIND = { trunk: '主干', branch: '枝', vein: '主脉' };
        var TREE_COLOR = { trunk: 'var(--lg-primary)', branch: 'var(--lg-cyan)', vein: '#c58b2f' };
        var TREE_INPUT_CSS = 'padding:5px 8px;border:1px solid var(--lg-input);border-radius:8px;'
          + 'background:transparent;color:var(--lg-text);font-size:13px;';

        function flatBranches(nodes, out) {
          out = out || [];
          (nodes || []).forEach(function (n) { out.push(n); flatBranches(n.children, out); });
          return out;
        }
        function treeAll() { return flatBranches((st.treeData && st.treeData.roots) || []); }
        function branchById(id) {
          var hit = null;
          treeAll().forEach(function (n) { if (n.id === id && !hit) hit = n; });
          return hit;
        }
        function linkFrom(l) { return String(l.fromBranch || l.from_branch || l.from || ''); }
        function linkTo(l) { return String(l.toBranch || l.to_branch || l.to || ''); }
        function labelOf(id) {
          var n = branchById(id);
          return n ? (n.name || n.id) : id;
        }
        function mkInput(ph, css) {
          var i = document.createElement('input');
          i.type = 'text';
          i.placeholder = ph || '';
          i.style.cssText = css || TREE_INPUT_CSS;
          return i;
        }

        function loadTreeAll() {
          body.textContent = '';
          body.appendChild(el('div', 'kv', '正在读取记忆树…'));
          Promise.all([
            api('/tree').catch(function () { return null; }),
            api('/conflicts').catch(function () { return null; }),
          ]).then(function (rs) {
            st.treeData = (rs[0] && rs[0].ok) ? rs[0] : { roots: [], links: [], total: 0, failed: true };
            st.conflicts = (rs[1] && rs[1].ok) ? (rs[1].conflicts || []) : [];
            if (st.treeSel && !branchById(st.treeSel)) st.treeSel = '';
            paintTree();
          });
        }

        function nodeRow(n, depth) {
          var kids = n.children || [];
          var box = el('div', null);
          var row = el('div', null);
          row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px;border-radius:7px;'
            + 'padding-left:' + (4 + depth * 15) + 'px;cursor:pointer;'
            + (st.treeSel === n.id ? 'background:rgba(77,107,254,.14);' : '');
          var tri = el('span', null, kids.length ? (st.collapsed[n.id] ? '▶' : '▼') : '');
          tri.style.cssText = 'width:12px;font-size:9px;opacity:.65;flex:none;';
          if (kids.length) {
            tri.onclick = function (ev) {
              ev.stopPropagation();
              st.collapsed[n.id] = !st.collapsed[n.id];
              paintTree();
            };
          }
          row.appendChild(tri);
          // 显示层(用户 2026-09-21 定):前端不写运算层级名;主干用一句话表示"还在生长"。
          var isTrunk = n.id === ((st.treeData && st.treeData.trunk) || 'trunk');
          var badge = el('span', null, isTrunk ? '🌱 你们的故事正在生长' : (TREE_KIND[n.kind] || n.kind));
          badge.style.cssText = 'font-size:11px;padding:1px 6px;border-radius:6px;flex:none;'
            + 'border:1px solid ' + (TREE_COLOR[n.kind] || 'var(--lg-border)') + ';'
            + 'color:' + (TREE_COLOR[n.kind] || 'inherit') + ';';
          row.appendChild(badge);
          var nm = el('span', null, n.name || n.id);
          nm.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
          row.appendChild(nm);
          var meta = el('span', 'm-meta', n.memories + ' 记忆 · ' + n.sessions + ' 会话'
            + (n.weightScale && Number(n.weightScale) !== 1 ? ' · ×' + n.weightScale : ''));
          meta.style.cssText = 'flex:none;opacity:.72;';
          row.appendChild(meta);
          // ---- 连边小标记(用户 2026-09-25) ----
          // 与侧栏记忆树同款:行内只留一个 ⇄N,不在这里铺开"连到哪里" ——
          // 选中本行后,下方"横向连边"区块才展开它的详情。
          var myLinks = (st.linkIndex && st.linkIndex[n.id]) || [];
          if (myLinks.length) {
            var lk = el('span', null, '⇄' + myLinks.length);
            lk.style.cssText = 'flex:none;font-size:11px;opacity:.9;color:#c58b2f;';
            lk.title = '与 ' + myLinks.length + ' 条枝横向关联 —— 选中本行可看连到哪里';
            row.appendChild(lk);
          }
          // ---- 选中:单击选中;Ctrl+单击 = 加选/减选(只影响高亮,记忆中心已无拖放) ----
          // 审计 C#15(双真值):选中只有一个真值 —— treeSel 主选中,extraSel 额外 Ctrl 选中的行。
          // 旧写法 row.onclick 里既改 treeMulti 又改 treeSel,两处都表示"选中",才会出现
          // "同一行两个来源各说各话"(颜色/后续操作取哪个不稳)。
          // 现在:treeSel = 主选中(唯一真值),extraSel = 额外 Ctrl 选中的行(不含主选中)。
          var isPrimary = (st.treeSel === n.id);
          var inMulti = st.extraSel.indexOf(n.id) >= 0;
          if (isPrimary || inMulti) {
            row.style.cssText += 'background:rgba(197,139,47,.20);outline:1px solid rgba(197,139,47,.55);';
          }
          row.onclick = function (ev) {
            if (ev && (ev.ctrlKey || ev.metaKey)) {
              // Ctrl:主轴不动,只增删"额外选中"集合(点主选中那一行的 Ctrl 由下面 else 收拢)
              var mi = st.extraSel.indexOf(n.id);
              if (mi >= 0) st.extraSel.splice(mi, 1);
              else if (!isPrimary) st.extraSel.push(n.id);
            } else {
              // 无 Ctrl:单选 —— 清掉其余选中,只留本行(再点本行 = 取消选中)。
              // 2026-09-25 用户裁决:旧写法把旧主轴"降级"进 extraSel 以求视觉不掉色,
              // 后果是**默认点击 = 累加多选**(不按 Ctrl 也越点越多),与侧栏行为不一致。
              // 现与侧栏对齐:直接点击 = 取消之前的选中并选中当前;Ctrl + 单击才是加选/减选。
              var wasPrimary = (st.treeSel === n.id);
              st.extraSel = [];
              st.treeSel = wasPrimary ? '' : n.id;
            }
            paintTree();
          };
          // 审计 C#15(无效拖拽):记忆中心已改为**只读视图**,doDrop() 首行就 return →
          // 这一整层 ondragstart/dragover/ondrop(以及它写进 st.dragIds 的拖动集合)全是死代码,
          // 还让每一行看起来能拖。整层删除,并明确告知改归属的地方。
          row.title = '记忆中心始终只读;直接点击 = 只选中这一条,Ctrl + 单击 = 加选/减选。想改归属请到右侧复盘栏「🔓 解锁编辑」后拖动。';
          box.appendChild(row);
          if (kids.length && !st.collapsed[n.id]) {
            kids.forEach(function (c) { box.appendChild(nodeRow(c, depth + 1)); });
          }
          return box;
        }

        /**
         * Ctrl+Z:只撤回**一步**侧栏复盘栏的操作(改归属 / 连边)。
         * 审计 C#15:原先这里还有一个 doDrop()(记忆中心的拖放落点),但它在
         * "记忆中心始终只读"那次裁决后首行就 `toast(...); return;`,下面 40 行
         * (撤销记账 / 连边 / 改归属)全是不可达死代码 —— 整段删除。
         * 现在记忆中心的 Ctrl+Z 只服务 st.lastDrop(由侧栏复盘栏写入),语义清晰。
         */
        function undoLastDrop() {
          var u = st.lastDrop;
          if (!u) return false;
          var acts = [];
          if (u.isLink) {
            u.links.forEach(function (x) {
              acts.push(api('/veins/unlink', { method: 'POST', body: { from: x.from, to: x.to } }));
            });
          } else {
            u.moves.forEach(function (x) {
              acts.push(api('/branches/reparent', { method: 'POST', body: { id: x.id, parentId: x.parentId } }));
            });
          }
          if (!acts.length) { st.lastDrop = null; return false; }
          Promise.all(acts).then(function () {
            st.lastDrop = null;
            toast('已撤回上一步' + (u.isLink ? '连边' : '移动'));
            loadTreeAll();
          }).catch(function () { toast('撤回失败'); });
          return true;
        }

        function buildReviewPrompt() {
          var all = treeAll();
          var links = (st.treeData && st.treeData.links) || [];
          var conf = st.conflicts || [];
          var pend = conf.filter(function (c) { return c.status === 'pending'; });
          var out = [];
          out.push('我们现在做一次记忆树复盘。');
          out.push('');
          out.push('【当前树】共 ' + all.length + ' 个节点');
          all.forEach(function (n) {
            out.push('- [' + (TREE_KIND[n.kind] || n.kind) + '] ' + (n.name || n.id)
              + ' —— ' + n.memories + ' 条记忆 / ' + n.sessions + ' 个会话'
              + (n.parentId ? '（挂在 ' + labelOf(n.parentId) + ' 下）' : ''));
          });
          if (links.length) {
            out.push('');
            out.push('【横向连边】');
            links.forEach(function (l) {
              out.push('- ' + labelOf(linkFrom(l)) + ' ↔ ' + labelOf(linkTo(l)) + '（' + (l.kind || 'related') + '）');
            });
          }
          out.push('');
          out.push('【待处理矛盾】' + (pend.length ? pend.length + ' 条' : '暂无'));
          pend.slice(0, 12).forEach(function (c) {
            out.push('- 「' + (c.aTitle || (c.a && c.a.convId) || '?') + '」 ⟷ 「'
              + (c.bTitle || (c.b && c.b.convId) || '?') + '」（' + c.kind + ' / ' + (c.detectedBy || '') + '）');
          });
          out.push('');
          out.push('请你先说出你看到的树的结构问题:哪些枝该并到一起、哪些该连边、哪些该改名;矛盾该以哪条为准。');
          out.push('我会逐条对齐 —— 你也可以纠正我。');
          return out.join('\n');
        }

        // ---------------- 一键生成记忆树(autotree,2026-09-20) ----------------
        // 三阶段:① 机械分段(零模型调用) ② 器灵批量命名 ③ 主人改名字后应用。
        // 用户的设计约束:模型只做"命名"这一件语义活;分段是机械活,不烧 token,也不该由模型做。
        function loadAutoPreview() {
          if (st.autoBusy) return;
          st.autoBusy = true;
          toast('正在机械分段…');
          api('/tree/autobuild/preview').then(function (r) {
            st.autoBusy = false;
            if (!r || !r.ok) { toast('✗ 分段失败:' + ((r && r.reason) || '未知')); paintTree(); return; }
            st.autoData = r;
            st.autoOpen = true;
            (r.buckets || []).forEach(function (b) {
              if (st.autoNames[b.id] === undefined) st.autoNames[b.id] = b.name || '';
            });
            toast('分好 ' + (r.buckets || []).length + ' 簇 —— 点「✦ 批量命名」让器灵起名');
            paintTree();
          }).catch(function () { st.autoBusy = false; paintTree(); toast('✗ 分段失败(网关)'); });
        }

        function runAutoName() {
          if (st.autoBusy || !st.autoData) { toast('先点「🌳 一键生成树」'); return; }
          var ids = (st.autoData.buckets || [])
            .filter(function (b) { return !String(st.autoNames[b.id] || '').trim(); })
            .map(function (b) { return b.id; });
          if (!ids.length) { toast('每一簇都有名字了 —— 可以直接应用,也可以先改名字'); return; }
          var total = ids.length;
          st.autoBusy = true;
          var done = 0;
          var step = function () {
            var batch = ids.splice(0, 2); // 每批 2 条:小助手单条命名要 10~20 秒,批次太大易被网关断开
            if (!batch.length) {
              st.autoBusy = false;
              paintTree();
              toast('命名完成 ' + total + ' 簇 —— 可改名字,再点「✓ 应用建枝」');
              return;
            }
            // 网关偶发抖动时重试一次,不要整批中断
            var attempt = function (left) {
              return api('/tree/autobuild/name', { method: 'POST', body: { bucketIds: batch, limit: batch.length } })
                .catch(function (e) {
                  if (left > 0) {
                    return new Promise(function (ok) { setTimeout(ok, 1200); }).then(function () { return attempt(left - 1); });
                  }
                  throw e;
                });
            };
            attempt(1).then(function (r) {
              if (!r || !r.ok) {
                st.autoBusy = false;
                paintTree();
                toast('✗ 命名中断(' + done + '/' + total + '):' + ((r && r.reason) || '未知'));
                return;
              }
              // ⚠ 字段名:端点返回的 named 是**计数**,名字数组在 items。
              // 写成 r.named.forEach 会抛 TypeError 并被 .catch 吞成"命名失败(网关)" —— 已中过一次。
              var items = r.items || [];
              items.forEach(function (n) { if (n && n.ok) st.autoNames[n.bucketId] = n.name; });
              var bad = items.filter(function (n) { return n && !n.ok; });
              done += batch.length;
              toast('命名中… ' + done + '/' + total + (bad.length ? '（本批 ' + bad.length + ' 条失败）' : ''));
              paintTree();
              step();
            }).catch(function (e) { st.autoBusy = false; paintTree(); toast('✗ 命名失败:' + ((e && e.message) || '网关')); });
          };
          step();
        }

        function applyAutoPlan() {
          if (st.autoBusy || !st.autoData) { toast('先点「🌳 一键生成树」'); return; }
          var plan = (st.autoData.buckets || [])
            .filter(function (b) { return String(st.autoNames[b.id] || '').trim(); })
            .map(function (b) {
              // 审计 C#12:**不要传 parentId** —— 后端只在 `!p.parentId` 时才把名字含「零散」的簇
              // 归并到主脉「零散会话」;旧写法硬传 'trunk' 让那条分支永不触发(零散枝散在主干下)。
              return { bucketId: b.id, mode: 'branch', name: String(st.autoNames[b.id]).trim() };
            });
          if (!plan.length) { toast('还没有名字 —— 先点「✦ 批量命名」'); return; }
          st.autoBusy = true;
          toast('正在建枝…');
          api('/tree/autobuild/apply', { method: 'POST', body: { plan: plan } }).then(function (r) {
            st.autoBusy = false;
            if (!r || !r.ok) { paintTree(); toast('✗ 应用失败:' + ((r && r.reason) || '未知')); return; }
            st.autoOpen = false; st.autoData = null; st.autoNames = {};
            // 审计 C#7(同型:把数组当计数):端点返回的 `created` 是**数组**、`unassigned` 字段不存在,
            // 旧写法 `r.created` 会渲染成「已建 [object Object],… 条枝」。
            var nCreated = Array.isArray(r.created) ? r.created.length : 0;
            toast('已建 ' + nCreated + ' 条枝'
              + (r.skipped ? '(跳过 ' + r.skipped + ' 条)' : '')
              + (r.note ? ' —— ' + r.note : ''));
            loadTreeAll();
          }).catch(function () { st.autoBusy = false; paintTree(); toast('✗ 应用失败(网关)'); });
        }

        function paintAuto() {
          if (!st.autoOpen || !st.autoData) return;
          var d = st.autoData;
          var list = d.buckets || [];
          var box = el('div', null);
          box.style.cssText = 'margin-top:10px;padding:8px 10px;border:1px solid var(--lg-border);border-radius:11px;';
          var head = el('div', null, '🌳 一键生成记忆树 —— 机械分段 ' + list.length + ' 簇');
          head.style.cssText = 'font-weight:700;margin-bottom:4px;';
          box.appendChild(head);
          box.appendChild(el('div', 'm-meta', '① 机械分段(零模型) → ② 器灵批量命名 → ③ 你改名字后应用。应用只建结构,不改写任何记忆内容。'));
          var bySrc = d.bySource || {};
          box.appendChild(el('div', 'm-meta', '来源分布:' + Object.keys(bySrc).map(function (k) { return k + ' ' + bySrc[k]; }).join(' · ')
            + ' ⚠ dsweb / import 的历史条目不是 DSH 会话,应用时挂不到枝上(会如实回报条数)'));

          var btnRow = el('div', 'btnrow');
          btnRow.style.cssText = 'margin:6px 0;flex-wrap:wrap;';
          var bName = el('button', null, '✦ 批量命名');
          var bApply = el('button', null, '✓ 应用建枝');
          var bClose = el('button', null, '✕ 收起');
          [bName, bApply, bClose].forEach(function (b) { b.type = 'button'; btnRow.appendChild(b); });
          if (st.autoBusy) [bName, bApply, bClose].forEach(function (b) { b.disabled = true; });
          bName.onclick = function () { runAutoName(); };
          bApply.onclick = function () { applyAutoPlan(); };
          bClose.onclick = function () { st.autoOpen = false; paintTree(); };
          box.appendChild(btnRow);

          var holder = el('div', null);
          holder.style.cssText = 'max-height:30vh;overflow:auto;border:1px solid var(--lg-border);border-radius:9px;padding:4px 6px;';
          list.forEach(function (b) {
            var row = el('div', null);
            row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:3px 0;flex-wrap:wrap;';
            var tag = el('span', null, String(b.source || ''));
            tag.style.cssText = 'font-size:11px;opacity:.75;flex:none;min-width:46px;';
            row.appendChild(tag);
            row.appendChild(el('span', 'm-meta', String(b.from || '?').slice(0, 10) + ' ~ ' + String(b.to || '?').slice(0, 10)
              + ' · ' + b.count + ' 条'));
            var inp = mkInput('(还没起名)', TREE_INPUT_CSS + 'flex:1;min-width:140px;');
            inp.value = st.autoNames[b.id] || '';
            inp.oninput = function () { st.autoNames[b.id] = inp.value; };
            row.appendChild(inp);
            // 「看内容」:展开这一簇实际包含哪些标题 —— 只给一个名字(如"零散记录")时
            //   主人无从判断该不该采纳(用户实测反馈)。内容来自 /tree/autobuild/preview 的 sample。
            var bPeek = el('button', null, st.autoExpand[b.id] ? '▾ 收起' : '▸ 看内容');
            bPeek.type = 'button';
            bPeek.style.cssText = 'flex:none;font-size:11px;padding:1px 7px;';
            bPeek.onclick = function () { st.autoExpand[b.id] = !st.autoExpand[b.id]; paintTree(); };
            row.appendChild(bPeek);
            holder.appendChild(row);
            if (st.autoExpand[b.id]) {
              var peek = el('div', null);
              peek.style.cssText = 'margin:0 0 7px 52px;padding:4px 8px;border-left:2px solid var(--lg-border);'
                + 'font-size:11px;line-height:1.55;opacity:.88;';
              var smp = b.sample || [];
              if (!smp.length) peek.appendChild(el('div', 'm-meta', '（这一簇没有可显示的标题）'));
              else {
                smp.forEach(function (t, i) { peek.appendChild(el('div', null, (i + 1) + '. ' + String(t || '（无标题）'))); });
                if (Number(b.count) > smp.length) {
                  peek.appendChild(el('div', 'm-meta', '…共 ' + b.count + ' 条,已显示前 ' + smp.length + ' 条'));
                }
              }
              holder.appendChild(peek);
            }
          });
          box.appendChild(holder);
          body.appendChild(box);
        }

        function paintTree() {
          body.textContent = '';
          var td = st.treeData || { roots: [], links: [], total: 0 };
          var all = treeAll();
          var links = td.links || [];
          var conf = st.conflicts || [];
          var pend = conf.filter(function (c) { return c.status === 'pending'; });
          // ---- 连边索引(用户 2026-09-25):节点 id → 挂在它身上的连边 ----
          // 用途两个:① nodeRow 行内画小标记(⇄N),让"这条枝有横向连边"平时可见;
          // ② 下方"横向连边"区块改为**只显示选中项**那几条 —— 原先是无条件铺开全部,
          //    连边一多这块就越来越臃肿,把真正该看的矛盾区挤下去。
          // 建在 paintTree、读在 nodeRow(共享 st 闭包),选中/重绘自动跟着更新。
          st.linkIndex = {};
          links.forEach(function (l) {
            var lf = linkFrom(l), lt = linkTo(l);
            if (lf) { (st.linkIndex[lf] = st.linkIndex[lf] || []).push(l); }
            if (lt) { (st.linkIndex[lt] = st.linkIndex[lt] || []).push(l); }
          });

          var tools = el('div', 'btnrow');
          // 左对齐(用户 2026-09-25):`.btnrow` 的全局 CSS 是 justify-content:flex-end(对"保存/取消"
          // 这类按钮行合适),但树工具条挂在面板左上,右对齐会让它飘到面板另一头,与下方树列表脱节。
          // 就地覆盖,不动全局 class(它被另外 15 处按钮行复用)。
          tools.style.cssText = 'margin:0 0 4px;flex-wrap:wrap;justify-content:flex-start;';
          // 记忆中心已改为**只读视图**(2026-09-22 用户裁决):扫重复 / 模型判定 / 归并零散枝 /
          // 解锁编辑等**复盘操作**全部移到右侧「器灵 · 复盘」栏 —— 这里只留「看」与一个总入口。
          var bRefresh = el('button', null, '刷新');
          var bReview = el('button', null, '🌱 一键复盘');
          bReview.title = '复制复盘开场白 + 解锁树编辑 + 打开右侧复盘栏 —— 复盘是"左会话 + 右侧栏"那个状态,不是一个开关。';
          var bAuto = el('button', null, st.autoOpen ? '🌳 收起生成面板' : '🌳 一键生成树');
          bReview.onclick = function () { startReviewFromMenu(); };
          [bRefresh, bReview, bAuto].forEach(function (b) { b.type = 'button'; tools.appendChild(b); });
          bAuto.onclick = function () {
            if (st.autoBusy) { toast('正在跑,稍等…'); return; }
            if (st.autoOpen) { st.autoOpen = false; paintTree(); return; }
            loadAutoPreview();
          };
          body.appendChild(tools);
          // 审计 C#15(死代码):原先这里还建了一行「＋ 建主脉」的 veinRow(veinName/bVein + 一句
          // 说明),但自从「＋建主脉」搬到右侧复盘栏后 **veinRow 再也不挂进 body** ——
          // 控件建了没人用,只有末尾那个 bVein.onclick 还引用着它。整块删除(能力在侧栏保留)。
          var treeHead = el('div', 'm-meta', '记忆树 —— 点击选中;点 ▶/▼ 折叠收起' + (td.failed ? ' ⚠ 读取失败' : ''));
          treeHead.style.cssText = 'margin:2px 0 4px;font-weight:700;opacity:.9;';
          body.appendChild(treeHead);
          var treeBox = el('div', null);
          // 选中/重绘时保持滚动位置(否则每次重建 DOM 都会跳回顶部 —— 用户 2026-09-22 反馈)
          treeBox.onscroll = function () { st.treeScroll = treeBox.scrollTop; };
          treeBox.style.cssText = 'border:1px solid var(--lg-border);border-radius:11px;padding:6px 8px;'
            + 'max-height:34vh;overflow:auto;';
          if (!all.length) {
            treeBox.appendChild(el('div', 'm-meta', td.failed ? '（读取失败,请刷新）' : '（还没有枝：主干应在这里,若为空说明库未迁移到 v6）'));
          } else {
            (td.roots || []).forEach(function (n) { treeBox.appendChild(nodeRow(n, 0)); });
          }
          body.appendChild(treeBox);
          if (st.treeScroll) treeBox.scrollTop = st.treeScroll;
          paintAuto();

          // ---- 选中节点的操作区(记忆中心只读,故这里只有提示,没有编辑控件) ----
          // 审计 C#15(死代码):原先这里跟着一个 `} else if (true) { ... } else { ...编辑控件... }`,
          // 那个 else 分支永远不可达(条件恒真),里面 130 行改名/并脉/连边/权重控件连同它们的
          // onclick(引用 rnIn/repSel/bRen/bLk 等只在该分支里声明的变量)整段是死代码 —— 一并删除。
          // 真正的编辑能力在右侧复盘栏(LingReviewBody),这里只负责"看"。
          var ops = el('div', null);
          ops.style.cssText = 'margin-top:10px;padding:8px 10px;border:1px dashed var(--lg-border);border-radius:11px;';
          ops.appendChild(el('div', 'm-meta', st.treeSel
            ? '🔒 树始终只读 —— 修改请点「🌱 一键复盘」,在右侧复盘栏「🔓 解锁编辑」后进行。'
            : '🔒 树平时只读 —— 进入复盘模式后可修改。(先点一条枝 / 主脉选中它)'));
          body.appendChild(ops);

          // ---- 横向连边(用户 2026-09-25 改):只显示**选中项**的连边 ----
          // 原先是无条件铺开全部连边 ⇒ 连边一多这块就越来越臃肿,把真正该看的矛盾区挤到下面。
          // 现在:行内只留 ⇄N 小标记(nodeRow 里画),选中哪条才展开它的详情;
          // 未选中时只给一行"共 N 条"的提示,可发现性不丢。
          var selLinks = (st.treeSel && st.linkIndex && st.linkIndex[st.treeSel]) || [];
          if (selLinks.length) {
            var lkHead = el('div', 'm-meta', '横向连边（' + selLinks.length + '）—— ' + labelOf(st.treeSel));
            lkHead.style.cssText = 'margin:10px 0 4px;font-weight:700;opacity:.9;';
            body.appendChild(lkHead);
            selLinks.forEach(function (l) {
              var other = (linkFrom(l) === st.treeSel) ? linkTo(l) : linkFrom(l);
              var row = el('div', 'm-meta', '↔ ' + labelOf(other)
                + '（' + (l.kind || 'related') + (l.note ? '：' + l.note : '') + '）');
              row.style.cssText = 'padding:3px 0;';
              var bUn = el('button', null, '断开');
              bUn.type = 'button';
              bUn.style.cssText = 'margin-left:8px;font-size:12px;';
              bUn.onclick = function () {
                api('/veins/unlink', { method: 'POST', body: { from: linkFrom(l), to: linkTo(l) } }).then(function () {
                  toast('已断开');
                  st.treeData = null;
                  loadTreeAll();
                });
              };
              row.appendChild(bUn);
              body.appendChild(row);
            });
          } else if (links.length) {
            var lkHint = el('div', 'm-meta', '横向连边（共 ' + links.length + ' 条,分布在 '
              + Object.keys(st.linkIndex).length + ' 个节点上）—— 带 ⇄ 标记的节点之间有横向关联,选中它就能看连到哪里。');
            lkHint.style.cssText = 'margin:10px 0 4px;opacity:.75;line-height:1.6;';
            body.appendChild(lkHint);
          }

          // ---- 矛盾区 ----
          var cHead = el('div', 'm-meta', '矛盾标记（待复盘 ' + pend.length + ' / 全部 ' + conf.length + '）');
          cHead.style.cssText = 'margin:12px 0 4px;font-weight:700;opacity:.9;';
          body.appendChild(cHead);
          var cHint = el('div', 'm-meta', '检出但未复盘时 —— 检索以**较新**的那条为准(旧的一条降权,不删除、不改写内容)。');
          cHint.style.cssText = 'margin-bottom:6px;opacity:.8;line-height:1.6;';
          body.appendChild(cHint);
          if (!conf.length) {
            body.appendChild(el('div', 'm-meta', '（暂无矛盾记录。点上面的「🕵 扫疑似重复」先捞一批措辞高度重复的候选,再用「✦ 模型判定」让模型读摘要定性质。）'));
          }
          conf.slice(0, 30).forEach(function (c) {
            var card = el('div', null);
            card.style.cssText = 'border:1px solid var(--lg-border);border-radius:10px;padding:8px 10px;margin:6px 0;';
            var stTag = { pending: '待复盘', confirmed: '已裁定', dismissed: '已驳回' }[c.status] || c.status;
            var badge = el('div', 'm-meta', (c.kind || 'conflict') + ' · ' + stTag
              + ' · ' + (c.detectedBy || '')
              + (c.score ? ' · 相似度 ' + Number(c.score).toFixed(2) : '')
              + (c.winner ? ' · 以 ' + (c.winner === 'a' ? 'A' : 'B') + ' 为准' : ''));
            badge.style.cssText = 'opacity:.75;margin-bottom:4px;';
            card.appendChild(badge);
            // 2026-09-21:每侧标题可点开看**摘要全文** —— 只给标题时人判不出"到底哪矛盾"(用户实测反馈)。
            function sideLine(tag, title, summary, convId) {
              var wrap = el('div', null);
              var head = el('div', null, tag + '：' + (title || convId || '?'));
              head.style.cssText = 'cursor:pointer;';
              wrap.appendChild(head);
              var sum = String(summary || '');
              if (!sum) return wrap;
              var hint = el('span', 'm-meta', '  [展开概述]');
              hint.style.cssText = 'opacity:.6;';
              head.appendChild(hint);
              var box = el('div', 'm-meta', sum);
              box.style.cssText = 'display:none;margin:2px 0 6px 12px;padding:6px 8px;'
                + 'border-left:2px solid var(--lg-border);opacity:.9;line-height:1.6;white-space:pre-wrap;';
              wrap.appendChild(box);
              head.onclick = function () {
                var open = box.style.display !== 'none';
                box.style.display = open ? 'none' : 'block';
                hint.textContent = open ? '  [展开概述]' : '  [收起]';
              };
              return wrap;
            }
            card.appendChild(sideLine('A', c.aTitle, c.aSummary, c.a && c.a.convId));
            card.appendChild(sideLine('B', c.bTitle, c.bSummary, c.b && c.b.convId));
            if (c.reason) card.appendChild(el('div', 'm-meta', '理由：' + c.reason));
            if (c.status === 'pending') {
              // 记忆中心只读:裁定动作搬到右侧复盘栏(2026-09-22)
              card.appendChild(el('div', 'm-meta', '  [待复盘] 裁定请到右侧复盘栏「器灵 · 复盘」进行(记忆中心只读)'));
            }
            body.appendChild(card);
          });

          // ---- 工具行为 ----
          bRefresh.onclick = function () { st.treeData = null; loadTreeAll(); };
        }

        function renderTree() {
          if (!st.treeData || !st.conflicts) return loadTreeAll();
          paintTree();
        }

        // S7(2026-09-18):小助手地址配置区(三级覆盖:界面配置 → 环境变量 → 内置默认)。
        // 挂在「接入历史」——诞生仪式也在这里,第一次上手的人必然经过,顺手就把小助手填了;
        // 填写频率极低,所以不做常驻入口。(放哪个 tab 属于还要一起打磨的事,不是定论。)
        function assistantZone() {
          var zone = el('div', 'scan-zone');
          zone.style.cssText = 'margin-top:10px;padding:10px 12px;border:1px dashed var(--lg-border);border-radius:11px;';
          var head = el('div', 'm-meta', '⚙ 小助手(本机小模型)地址');
          head.style.cssText = 'font-weight:700;opacity:.9;margin-bottom:4px;';
          var desc = el('div', 'm-meta', '补摘要、给记忆起名都走它。这里填的是「服务地址」(HTTP 端点),不是文件夹:'
            + '单机自用就填 http://127.0.0.1:11434/v1;小助手跑在别的机器上,把 IP 换成那台机器(例 http://192.168.1.10:11434/v1)。'
            + '留空则依次回落到环境变量 DSH_LING_ASSISTANT 与内置默认。');
          desc.style.cssText = 'margin:0 0 8px;line-height:1.7;opacity:.85;';
          var asstWrap = el('div', null);
          asstWrap.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;';
          var asstUrl = document.createElement('input');
          asstUrl.type = 'text';
          asstUrl.style.cssText = 'flex:1;min-width:220px;padding:6px 10px;border:1px solid var(--lg-input);border-radius:9px;background:transparent;color:var(--lg-text);font-size:13px;';
          asstUrl.placeholder = '例如 http://127.0.0.1:11434/v1(服务地址,不是文件夹;留空 = 环境变量 / 内置默认)';
          var asstModel = document.createElement('input');
          asstModel.type = 'text';
          asstModel.style.cssText = 'width:180px;padding:6px 10px;border:1px solid var(--lg-input);border-radius:9px;background:transparent;color:var(--lg-text);font-size:13px;';
          asstModel.placeholder = '模型名(如 qwen3.5:9b)';
          var bAsstSave = el('button', null, '保存地址');
          bAsstSave.type = 'button';
          var bAsstTest = el('button', null, '测试连通');
          bAsstTest.type = 'button';
          var asstRes = el('div', 'm-meta', '');
          asstRes.style.cssText = 'width:100%;margin-top:6px;white-space:pre-wrap;line-height:1.7;';
          function asstSourceLabel(s) {
            return s === 'settings' ? '界面配置' : s === 'env' ? '环境变量' : '内置默认';
          }
          function loadAsst() {
            api('/assistant/config').then(function (r) {
              if (!r || !r.ok) return;
              asstUrl.value = (r.configured && r.configured.baseUrl) || '';
              asstModel.value = (r.configured && r.configured.model) || '';
              asstRes.textContent = '小助手生效地址: ' + r.baseUrl + ' · ' + r.model +
                '(来源:' + asstSourceLabel(r.source) + ';内置默认 ' + r.defaults.baseUrl + ')' +
                (r.env && r.env.baseUrl ? '\n环境变量 DSH_LING_ASSISTANT = ' + r.env.baseUrl : '');
            }).catch(function () {});
          }
          bAsstSave.onclick = function () {
            bAsstSave.disabled = true;
            api('/assistant/config', { method: 'POST', body: { baseUrl: asstUrl.value, model: asstModel.value } }).then(function (r) {
              bAsstSave.disabled = false;
              if (!r || !r.ok) { asstRes.textContent = '✗ ' + ((r && r.message) || (r && r.error) || '保存失败'); return; }
              asstRes.textContent = '✓ 已保存 · 生效: ' + r.baseUrl + ' · ' + r.model + '(' + asstSourceLabel(r.source) + ')';
            }).catch(function () { bAsstSave.disabled = false; asstRes.textContent = '✗ 保存失败(网关)'; });
          };
          bAsstTest.onclick = function () {
            bAsstTest.disabled = true;
            asstRes.textContent = '探测中…';
            api('/assistant/test', { method: 'POST', body: { baseUrl: asstUrl.value, model: asstModel.value } }).then(function (r) {
              bAsstTest.disabled = false;
              asstRes.textContent = (r && r.ok)
                ? ('✓ 在线:' + ((r.models || []).join('/') || '(未报模型名)') + ' @ ' + r.baseUrl)
                : ('✗ 未探测到(' + ((r && r.reason) || '?') + ') @ ' + ((r && r.baseUrl) || '?') + '\n' + ((r && r.hint) || ''));
            }).catch(function () { bAsstTest.disabled = false; asstRes.textContent = '✗ 探测失败(网关)'; });
          };
          asstWrap.appendChild(asstUrl);
          asstWrap.appendChild(asstModel);
          asstWrap.appendChild(bAsstSave);
          asstWrap.appendChild(bAsstTest);
          zone.appendChild(head);
          zone.appendChild(desc);
          zone.appendChild(asstWrap);
          zone.appendChild(asstRes);
          loadAsst();
          return zone;
        }

        // ---------------- 接入历史(ACCESS-DESIGN):通道 A 本机扫描 + 通道 B 契约文件 ----------------
        function renderAccess() {
          body.textContent = '';
          var g = el('div', null);
          // —— 通道 A:DSH 本机存量会话 ——
          var cardA = el('div', 'scan-zone');
          cardA.style.cssText = 'margin-bottom:14px;padding:12px 14px;border:1px dashed var(--lg-border);border-radius:12px;';
          cardA.appendChild(el('div', 'm-meta', 'A · 用本机 DSH 会话培养'));
          var descA = el('div', 'm-meta', '');
          descA.style.cssText = 'margin:2px 0 8px;line-height:1.7;opacity:.85;';
          descA.textContent = '扫描你在这台电脑上 DeepSeek Harness 里的历史会话(捕捉功能上线之前的存量)。只读会话文件,不入原文,只提炼成"记忆概述"。';
          cardA.appendChild(descA);
          var rowA = el('div', 'm-acts');
          var bScan = el('button', 'primary', '扫描本机 DSH 历史会话');
          var resA = el('div', 'm-meta', '');
          resA.style.cssText = 'width:100%;margin-top:6px;';
          bScan.onclick = function () {
            bScan.disabled = true;
            var old = bScan.textContent;
            bScan.textContent = '扫描中…(需要几秒到几十秒)';
            resA.textContent = '';
            api('/dsh/backfill', { method: 'POST', body: {} }).then(function (r) {
              bScan.disabled = false;
              bScan.textContent = old;
              if (r && r.ok) {
                resA.textContent = '✓ 候选 ' + r.scanned + ' · 顶层 ' + r.topLevel + ' · 新增 ' + r.created +
                  ' · 已存在跳过 ' + r.skippedExists + ' · 弱会话跳过 ' + r.skippedWeak +
                  (r.failed ? ' · 解码失败 ' + r.failed : '') + ' · 库内 DSH 共 ' + r.totalDsh + ' 条';
                toast('DSH 历史扫描完成:新增 ' + r.created + ' 条记忆');
              } else {
                resA.textContent = '✗ ' + ((r && r.message) || JSON.stringify(r || {}).slice(0, 140));
              }
            }).catch(function () {
              bScan.disabled = false;
              bScan.textContent = old;
              resA.textContent = '✗ 扫描失败(网关不可达)';
            });
          };
          rowA.appendChild(bScan);
          cardA.appendChild(rowA);
          cardA.appendChild(resA);
          g.appendChild(cardA);

          // —— 通道 B:会话契约文件(JSON / JSONL)——
          var cardB = el('div', 'scan-zone');
          cardB.style.cssText = 'margin-bottom:8px;padding:12px 14px;border:1px dashed var(--lg-border);border-radius:12px;';
          cardB.appendChild(el('div', 'm-meta', 'B · 用导出的对话文件培养(JSON / JSONL 契约)'));
          var descB = el('div', 'm-meta', '');
          descB.style.cssText = 'margin:2px 0 8px;line-height:1.7;opacity:.85;white-space:pre-wrap;';
          descB.textContent = '文件里每个会话可带 messages(完整对话)或只有 title/时间/summary(轻量档)。\n支持两种形态:\n  ① 纯 JSON:{"sessions":[...]} 或数组 [ ... ]\n  ② JSONL:每行一个会话对象\n字段:id / startedAt / updatedAt / title / category / messages[{role:"user|assistant",text,at}] / summary / keywords。';
          cardB.appendChild(descB);
          var rowB = el('div', 'm-acts');
          var fileInput = document.createElement('input');
          fileInput.type = 'file';
          fileInput.accept = '.json,.jsonl,.txt,application/json';
          fileInput.style.display = 'none';
          var bPick = el('button', 'primary', '选择对话文件…');
          bPick.onclick = function () { fileInput.click(); };
          var bGo = el('button', null, '解析并预览');
          bGo.disabled = true;
          rowB.appendChild(bPick);
          rowB.appendChild(bGo);
          cardB.appendChild(rowB);
          var resB = el('div', 'm-meta', '');
          resB.style.cssText = 'width:100%;margin-top:8px;white-space:pre-wrap;line-height:1.7;';
          cardB.appendChild(fileInput);
          cardB.appendChild(resB);
          g.appendChild(cardB);

          // —— S7:小助手(本机小模型)地址 —— 补摘要与记忆起名都走它,是通道 A/B 之后的共同底座 ——
          var cardAsst = assistantZone();
          cardAsst.style.cssText = 'margin-bottom:14px;padding:12px 14px;border:1px dashed var(--lg-border);border-radius:12px;';
          g.appendChild(cardAsst);

          // —— 诞生仪式:让她读这段历史 + 第一次自我介绍 ——
          var cardC = el('div', 'scan-zone');
          cardC.style.cssText = 'padding:12px 14px;border:1px dashed var(--lg-border);border-radius:12px;';
          cardC.appendChild(el('div', 'm-meta', she('🌱 诞生仪式:让她认识你')));
          var descC = el('div', 'm-meta', '');
          descC.style.cssText = 'margin:2px 0 8px;line-height:1.7;opacity:.85;';
          descC.textContent = she('她会先"读"长会话(逐条深摘需几秒;短会话无需深摘,自会以原文片段参与),然后试着做第一次自我介绍。初稿默认按"生活与情感优先"取材——她首先是伴侣,其次才是同事。');
          cardC.appendChild(descC);
          var rowC = el('div', 'm-acts');
          var bRun = el('button', 'primary', she('让她读未读过的会话'));
          var bGen = el('button', null, she('🌱 让她第一次自我介绍'));
          bGen.style.display = 'none';
          bGen.type = 'button';
          var selScope = makeSel([
            { v: 'all', l: '读全部记忆(含网页端/DSH)' },
            { v: 'import', l: '只读刚导入的这段' },
          ], 'all', function () {});
          rowC.appendChild(selScope.node);
          rowC.appendChild(bRun);
          rowC.appendChild(bGen);
          cardC.appendChild(rowC);
          var resC = el('div', 'm-meta', '');
          resC.style.cssText = 'width:100%;margin-top:8px;white-space:pre-wrap;line-height:1.7;';
          var genOut = el('div', 'ling-draft-out', '');
          genOut.style.cssText = 'width:100%;';
          cardC.appendChild(resC);
          cardC.appendChild(genOut);
          g.appendChild(cardC);

          // —— 导入记录:每次把历史请进门都留一笔账 ——
          var cardD = el('div', 'scan-zone');
          cardD.style.cssText = 'padding:12px 14px;border:1px dashed var(--lg-border);border-radius:12px;';
          var logHead = el('div', 'm-meta');
          logHead.style.cssText = 'display:flex;align-items:center;gap:8px;';
          logHead.appendChild(el('span', null, '📜 导入记录(最近 50 条,自动留档)'));
          var bLogRefresh = el('button', null, '刷新');
          bLogRefresh.type = 'button';
          bLogRefresh.style.cssText = 'min-height:24px;padding:0 10px;font-size:12px;';
          logHead.appendChild(bLogRefresh);
          cardD.appendChild(logHead);
          var logOut = el('div', 'm-meta', '');
          logOut.style.cssText = 'width:100%;margin-top:6px;white-space:pre-wrap;line-height:1.7;max-height:190px;overflow:auto;';
          cardD.appendChild(logOut);
          g.appendChild(cardD);
          body.appendChild(g);

          function renderImportLog() {
            api('/import/history').then(function (r) {
              logOut.textContent = '';
              if (!r || !r.ok || !r.items || !r.items.length) {
                logOut.appendChild(el('div', 'm-empty', '还没有导入记录 —— 从上面把一段历史请进来,这里就会留账。'));
                return;
              }
              r.items.slice(0, 20).forEach(function (it) {
                logOut.appendChild(el('div', null, it.line || ''));
              });
              if (r.items.length > 20) logOut.appendChild(el('div', 'm-meta', '(仅显示最近 20 条)'));
            }).catch(function () { logOut.textContent = '记录加载失败(网关不可达)'; });
          }
          bLogRefresh.onclick = renderImportLog;
          renderImportLog();

          // 深摘(轮询)与 genesis 流程;草稿制:候选加入草稿 → 带去人格中心人审(乙方案)
          var pollTimer = null;
          var draftIntro = null;   // {aiTitle}
          var draftName = null;    // {aiName}
          var draftHints = [];     // {label,text}(语气建议/相处观察)
          var hintBtns = [];
          var introBtns = [];
          var nameBtns = [];
          var RUN_LABEL = she('让她读未读过的会话');
          function draftSummary() {
            var parts = [];
            if (draftIntro) parts.push('自述(1)');
            if (draftName) parts.push('名字:' + draftName.aiName);
            if (draftHints.length) parts.push(she('她的话:') + draftHints.map(function (h) { return h.label; }).join('+'));
            return parts.length ? parts.join(' · ') : '';
          }
          function statusLine(st) {
            var okN = (st.done || []).filter(function (d) { return d.ok; }).length;
            var bad = (st.done || []).filter(function (d) { return !d.ok; }).map(function (d) {
              return d.id + (d.reason === 'below-min' ? '(短会话,无需深摘)' : '(' + (d.reason || '?') + ')');
            }).slice(0, 4).join('、');
            return { okN: okN, bad: bad };
          }
          function runBatch() {
            bRun.disabled = true;
            bRun.textContent = '启动中…';
            resC.textContent = '';
            api('/deep/run-import', { method: 'POST', body: {} }).then(function (r) {
              if (!r || !r.ok) {
                bRun.disabled = false;
                if (r && r.reason === 'none') {
                  // 全部已读不是失败:直接可让她介绍自己(短会话以片段参与,无需深摘)
                  bRun.textContent = '已全部读过';
                  bRun.disabled = true;
                  bGen.style.display = '';
                  resC.textContent = she('她已读过(或无需浓缩)这段历史里的所有会话 —— 让她试着介绍自己吧。');
                  return;
                }
                bRun.textContent = RUN_LABEL;
                resC.textContent = '✗ ' + ((r && r.message) || '启动失败');
                return;
              }
              poll();
            }).catch(function () {
              bRun.disabled = false;
              bRun.textContent = RUN_LABEL;
              resC.textContent = '✗ 启动失败(网关不可达)';
            });
          }
          function poll() {
            api('/deep/run-status').then(function (st) {
              if (!st || !st.ok) { bRun.disabled = false; bRun.textContent = RUN_LABEL; resC.textContent = '状态不可达,请重试'; return; }
              if (st.running) {
                var doneN = st.done ? st.done.length : 0;
                var pct = st.total > 0 ? Math.round((doneN / st.total) * 100) : 0;
                resC.textContent = she('她正在读这段历史… 已完成 ') + doneN + ' / 本轮共 ' + st.total + ' · ' + pct + '%(每条约几秒,请稍候)';
                pollTimer = setTimeout(poll, 1500);
                return;
              }
              finishBatch(st);
            }).catch(function () {
              pollTimer = setTimeout(poll, 1500);
            });
          }
          function finishBatch(st) {
            bRun.disabled = false;
            bRun.textContent = RUN_LABEL;
            var s = statusLine(st);
            var lines = ['✓ 读完 ' + st.total + ' 条长会话:成功 ' + s.okN + ' 条' + (s.bad ? ' · ' + s.bad : '')];
            lines.push(s.okN > 0
              ? she('她已读过其中的一部分 —— 现在可以让她试着介绍自己了(短会话会以原文片段参与,不会缺席)。')
              : she('历史多为短会话(无需深摘)—— 仍可让她按已有记忆试着介绍自己。'));
            bGen.style.display = '';
            resC.textContent = lines.join('\n');
          }
          bRun.onclick = runBatch;
          bGen.onclick = function () {
            bGen.disabled = true;
            var old = bGen.textContent;
            bGen.textContent = she('她在想怎么开口…');
            resC.textContent = '';
            genOut.textContent = '';
            draftIntro = null;
            draftName = null;
            draftHints = [];
            hintBtns = [];
            api('/persona/genesis', { method: 'POST', body: { scope: selScope.value } }).then(function (r) {
              bGen.disabled = false;
              bGen.textContent = old;
              if (!r || !r.ok) { resC.textContent = '✗ ' + ((r && r.message) || '仪式失败'); return; }
              resC.textContent = (r.scope === 'all'
                ? she('她翻遍了全部记忆,按生活/情感加权选出 ') + r.sampled + she(' 条样本 —— 以下是她想对你说的话;挑中意的加入草稿,带去人格中心人审:')
                : she('她读了刚导入的这段历史(') + r.sampled + she(' 条)—— 以下是她想对你说的话;挑中意的加入草稿,带去人格中心人审:'));
              renderGenesis(r.result);
            }).catch(function () { bGen.disabled = false; bGen.textContent = old; resC.textContent = '✗ 仪式失败(网关)'; });
          };
          function renderGenesis(result) {
            if (!result) return;
            genOut.textContent = '';
            introBtns = [];
            nameBtns = [];
            hintBtns = [];
            var rst = result;
            function head(t) {
              var d = el('div', 'm-meta');
              d.style.cssText = 'font-weight:700;opacity:.95;margin:10px 0 4px;';
              d.textContent = t;
              return d;
            }
            function pickBtn(isSel, label, onToggle) {
              var b = el('button', isSel ? 'primary' : null, label);
              b.type = 'button';
              b.onclick = function () { onToggle(); };
              return b;
            }
            function setPickState(btn, picked) {
              btn.textContent = picked ? '已选 · 点此取消' : '加入草稿';
              btn.className = picked ? 'primary' : '';
            }
            if (rst.self_intros && rst.self_intros.length) {
              genOut.appendChild(head(she('她对自己的介绍(单选一段加入草稿)')));
              var introPicked = [false, false, false];
              rst.self_intros.forEach(function (s, i) {
                var line = el('div', 'ling-draft-item');
                line.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin:5px 0;font-size:13px;';
                var txt = el('span', null, '自述 ' + (i + 1) + ': ' + s);
                txt.style.cssText = 'flex:1;line-height:1.6;opacity:.95;white-space:pre-wrap;';
                var bt = el('button', null, '加入草稿');
                bt.onclick = function () {
                  if (introPicked[i]) {
                    introPicked[i] = false;
                    if (draftIntro && draftIntro.aiTitle === s) draftIntro = null;
                  } else {
                    introPicked.forEach(function (_, j) { introPicked[j] = j === i; });
                    draftIntro = { aiTitle: s };
                  }
                  introPicked.forEach(function (p, j) {
                    var btn = introBtns[j];
                    if (btn) setPickState(btn, p);
                  });
                  refreshDraftBar();
                };
                introBtns.push(bt);
                line.appendChild(txt);
                line.appendChild(bt);
                genOut.appendChild(line);
              });
            }
            if (rst.name_pairs && rst.name_pairs.length) {
              genOut.appendChild(head(she('她建议的名字(单选一组加入草稿)')));
              var namePicked = [false, false, false];
              rst.name_pairs.forEach(function (p, i) {
                var line = el('div', 'ling-draft-item');
                line.style.cssText = 'display:flex;gap:8px;align-items:center;margin:5px 0;font-size:13px;';
                var txt = el('span', null, '正式名「' + p.formal + '」 / 昵称「' + (p.nick || '—') + '」');
                txt.style.cssText = 'flex:1;opacity:.95;';
                var bt = el('button', null, '加入草稿');
                bt.onclick = function () {
                  if (namePicked[i]) {
                    namePicked[i] = false;
                    draftName = null;
                  } else {
                    namePicked.forEach(function (_, j) { namePicked[j] = j === i; });
                    draftName = { aiName: p.formal + (p.nick ? '/' + p.nick : '') };
                  }
                  namePicked.forEach(function (p2, j) {
                    var btn = nameBtns[j];
                    if (btn) setPickState(btn, p2);
                  });
                  refreshDraftBar();
                };
                nameBtns.push(bt);
                line.appendChild(txt);
                line.appendChild(bt);
                genOut.appendChild(line);
              });
            }
            function hintRow(label, text) {
              if (!text) return;
              genOut.appendChild(head(label + she('(可加入草稿,到人格中心后作为"她的话"记入习惯)')));
              var line = el('div', 'ling-draft-item');
              line.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin:5px 0;font-size:13px;';
              var txt = el('span', null, text);
              txt.style.cssText = 'flex:1;line-height:1.6;opacity:.95;white-space:pre-wrap;';
              var picked = false;
              var bt = el('button', null, '加入草稿');
              bt.onclick = function () {
                picked = !picked;
                if (picked) draftHints.push({ label: label, text: text });
                else draftHints = draftHints.filter(function (h) { return h.text !== text; });
                setPickState(bt, picked);
                refreshDraftBar();
              };
              hintBtns.push(bt);
              line.appendChild(txt);
              line.appendChild(bt);
              genOut.appendChild(line);
            }
            hintRow('语气建议', rst.tone_advice);
            hintRow('相处观察', rst.observations);
            // 草稿条 + 去人格中心
            var draftBar = el('div', 'ling-seal');
            draftBar.style.cssText = 'margin:12px 0 2px;';
            var barTxt = el('span', 'st', '草稿:尚未选择');
            draftBar.appendChild(barTxt);
            var bCarry = el('button', 'primary', '带着草稿去人格中心人审');
            bCarry.type = 'button';
            bCarry.disabled = true;
            bCarry.onclick = function () {
              openPersonaEditor({
                aiName: draftName ? draftName.aiName : undefined,
                aiTitle: draftIntro ? draftIntro.aiTitle : undefined,
                hints: draftHints.slice(),
              });
            };
            draftBar.appendChild(bCarry);
            genOut.appendChild(draftBar);
            function refreshDraftBar() {
              var t = draftSummary();
              barTxt.textContent = t ? '草稿:' + t : '草稿:尚未选择';
              bCarry.disabled = !(draftIntro || draftName || draftHints.length);
            }
            var guide2 = el('div', 'm-meta', '');
            guide2.style.cssText = 'margin-top:6px;opacity:.8;';
            guide2.textContent = she('tips:自述/名字会在人格中心对应字段旁显示「她建议 … [填入]」;语气建议与相处观察会作为"她的话"出现在人格中心,可一键「认可这条习惯」(自由成长,无需手术)。已定型字段填入前需先手术。');
            genOut.appendChild(guide2);
            refreshDraftBar();
          }
          var pendingItems = null; // 客户端只做结构切分,schema 校验在服务端
          var currentFileName = ''; // 记文件名,导入记录里留账
          function splitDoc(text) {
            var t = String(text || '');
            if (!t.trim()) return { items: [], note: '文件为空' };
            var first = t.trim().charAt(0);
            if (first === '[' || first === '{') {
              var obj = JSON.parse(t); // 抛错向上报
              if (Array.isArray(obj)) return { items: obj, note: '' };
              if (obj && Array.isArray(obj.sessions)) return { items: obj.sessions, note: '' };
              throw new Error('JSON 需为数组或 {"sessions":[...]}');
            }
            var items = [];
            var bad = 0;
            t.split('\n').forEach(function (line) {
              var s = line.trim();
              if (!s) return;
              try { items.push(JSON.parse(s)); } catch { bad += 1; }
            });
            if (!items.length) throw new Error('JSONL 中没有可解析的行' + (bad ? '(损坏 ' + bad + ' 行)' : ''));
            return { items: items, note: bad ? ('忽略损坏行 ' + bad + ' 条') : '' };
          }
          function preview() {
            var f = fileInput.files && fileInput.files[0];
            if (!f) return;
            currentFileName = f.name || '';
            resB.textContent = '读取文件…';
            var reader = new FileReader();
            reader.onload = function () {
              try {
                var doc = splitDoc(String(reader.result));
                if (doc.note) resB.textContent = doc.note + '\n';
                pendingItems = doc.items;
                resB.textContent = (resB.textContent || '') + '解析到会话 ' + doc.items.length + ' 条 —— 点击下方「确认导入」分批写入(200/批)。';
                bGo.textContent = '确认导入(' + doc.items.length + ' 条)';
                bGo.disabled = false;
              } catch (e) {
                resB.textContent = '✗ 解析失败:' + e.message;
                pendingItems = null;
                bGo.disabled = true;
              }
            };
            reader.readAsText(f);
          }
          bGo.onclick = function () {
            if (!pendingItems || !pendingItems.length) return;
            bGo.disabled = true;
            var old = bGo.textContent;
            var items = pendingItems;
            pendingItems = null;
            var totals = { newRows: 0, refreshed: 0, upgraded: 0, folded: 0, removedImport: 0, accepted: 0, rejected: 0, degraded: 0, degradedReasons: {}, errors: 0 };
            var rejPreview = [];
            var batch = 200;
            // 一次导入 = 一条账:runId 贯穿全部批,at = 导入开始时刻(服务端固定后不再变动)
            var runId = 'imp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            var startedAt = Date.now();
            var idx = 0;
            function reportError() {
              api('/import/log', {
                method: 'POST',
                body: { runId: runId, at: startedAt, file: currentFileName, errors: 1 },
              }).catch(function () {});
            }
            function next() {
              var chunk = items.slice(idx, idx + batch);
              if (!chunk.length) return finish();
              idx += batch;
              resB.textContent = '导入中…' + Math.min(idx, items.length) + '/' + items.length;
              api('/import/file/batch', {
                method: 'POST',
                body: { items: chunk, file: currentFileName, runId: runId, at: startedAt },
              }).then(function (r) {
                if (r && r.ok) {
                  totals.accepted += r.accepted || 0;
                  totals.newRows += r.newRows || 0;
                  totals.refreshed += r.refreshed || 0;
                  totals.upgraded += r.upgraded || 0;
                  totals.folded += r.folded || 0;
                  totals.removedImport += r.removedImport || 0;
                  totals.degraded += r.degraded || 0;
                  if (r.degradedReasons) {
                    Object.keys(r.degradedReasons).forEach(function (k) {
                      totals.degradedReasons[k] = (totals.degradedReasons[k] || 0) + (r.degradedReasons[k] || 0);
                    });
                  }
                  if (r.rejected && r.rejected.length) {
                    totals.rejected += r.rejected.length;
                    r.rejected.slice(0, 3).forEach(function (rj) {
                      var at = idx - batch + rj.i + 1;
                      if (rejPreview.length < 5) rejPreview.push('第 ' + at + ' 条:' + rj.reason);
                    });
                  }
                } else {
                  totals.errors += 1;
                  reportError();
                  if (rejPreview.length < 5) rejPreview.push('批失败:' + ((r && (r.message || r.error || r.reason)) || '未知'));
                }
                next();
              }).catch(function () {
                totals.errors += 1;
                reportError();
                if (rejPreview.length < 5) rejPreview.push('批失败(网关)');
                next();
              });
            }
            function finish() {
              bGo.disabled = false;
              bGo.textContent = old;
              // S5(2026-09-17 导入诚实化):「有壳无肉」时绝不说"✓ 导入完成"。
              // 旧文案把"对话解析不出来"说成"降级为轻量",用户以为导入成功了,其实正文一条没进。
              var shell = totals.degraded || 0;
              var why = Object.keys(totals.degradedReasons).map(function (k) {
                return k + ' ×' + totals.degradedReasons[k];
              }).join(';');
              var lines = [];
              if (shell) {
                lines.push('⚠ 导入不完全:写入 ' + totals.newRows + ' 条 · 刷新 ' + totals.refreshed + ' 条,其中 ' +
                  shell + ' 条只有标题、没有对话正文');
                lines.push('  原因:' + (why || '文件里的对话格式没能认出来') +
                  ' —— 这些记忆暂时只有壳,深摘也补不出内容。');
              } else {
                lines.push('✓ 导入完成:写入新记忆 ' + totals.newRows + ' 条 · 刷新已有 ' + totals.refreshed + ' 条' +
                  (totals.upgraded ? ' · 补全对话原文 ' + totals.upgraded + ' 条' : '') +
                  (totals.folded ? ' · 并入网页端历史 ' + totals.folded + ' 条(含对话原文)' : '') +
                  (totals.removedImport ? ' · 清理重复副本 ' + totals.removedImport + ' 条' : ''));
              }
              lines.push('  校验通过 ' + totals.accepted + ' · 拒绝 ' + totals.rejected + (totals.errors ? ' · 批错误 ' + totals.errors : ''));
              rejPreview.forEach(function (x) { lines.push('  ⚠ ' + x); });
              if (!totals.errors && totals.accepted && !shell) {
                lines.push(she('她开始读这些日子了 —— 深摘要会在后台按热度慢慢补齐。'));
              }
              resB.textContent = lines.join('\n');
              renderImportLog();
            }
            next();
          };
          fileInput.onchange = preview;
        }

        function render() {
          if (st.tab === 'overview') renderOverview();
          else if (st.tab === 'browse') renderBrowse();
          else if (st.tab === 'tree') renderTree();
          else renderAccess();
        }
        render();
      }

      // ---------------- 建议中心(语料提炼 + 点踩成长) ----------------
      function openFeedbackPanel() {
        ensureStyle();
        closeOverlays();
        var KIND_NAME = { aiName: '自称', userTitle: '称呼', hardrule: '习惯' };
        var wrap = el('div', 'dsh-ling-panel');
        wrap.dataset.dark = dark();
        var h = el('h3', null, '建议中心 · 语料提炼 + 成长回路');
        h.appendChild(el('div', 'hint', she('规矩:你的指令,可直接加(也可在会话里说"记进规矩");习惯:只能由她长出来,你点头才定。下半是语料提炼与点踩素材。')));
        wrap.appendChild(h);
        var body = el('div', 'kv', '加载中…');
        wrap.appendChild(body);
        var btnRow = el('div', 'btnrow');
        var close = el('button', null, '关闭');
        var refresh = el('button', null, '刷新');
        btnRow.appendChild(refresh);
        btnRow.appendChild(close);
        wrap.appendChild(btnRow);
        document.body.appendChild(wrap);
        armOverlays();
        initPanelDrag(wrap, 'advice');
        close.onclick = closeOverlays;
        refresh.onclick = render;

        function blockTitle(t) {
          var d = el('div', 'm-meta');
          d.style.cssText = 'font-weight:700;opacity:.9;margin:10px 0 4px;';
          d.textContent = t;
          return d;
        }
        function card(it) {
          var c = el('div', 'dsh-ling-panel');
          c.style.cssText = 'position:static;box-shadow:none;border:1px solid var(--lg-border-soft);margin:5px 0;padding:8px 10px;max-height:none;width:auto;';
          c.dataset.dark = dark();
          return c;
        }

        // ---- 规矩 / 习惯(2026-09-15 定稿:指令直达,人格不直达)----
        function renderTiers(fragOuter) {
          var box = el('div', null);
          fragOuter.appendChild(box);   // 同步挂进 fragment:之后异步填充才不会被丢掉
          var frag = box;
          api('/persona/rules').then(function (r) {
            if (!r || !r.ok) {
              frag.appendChild(blockTitle('◈ 规矩 / 习惯'));
              frag.appendChild(el('div', 'm-empty', '读不到规矩/习惯 —— 多半是宿主(host)还没重启(新接口未生效)。重启宿主后再点「刷新」。'));
              return;
            }
            // ① 规矩:可直接追加(面板写入不需另附原话)
            frag.appendChild(blockTitle('◈ 规矩(你的指令 · 可直接加)'));
            var rules = r.rules || [];
            if (!rules.length) frag.appendChild(el('div', 'm-empty', '还没有规矩。'));
            rules.forEach(function (it) {
              var c = card(it);
              c.appendChild(el('div', null, it.text));
              var meta = [];
              if (it.source === 'panel') meta.push('面板写入');
              else if (it.quote) meta.push('原话:' + String(it.quote).slice(0, 36));
              if (it.at) meta.push(String(new Date(Number(it.at)).toISOString()).slice(0, 10));
              if (meta.length) c.appendChild(el('div', 'm-meta', meta.join(' · ')));
              var row = el('div', 'btnrow');
              var del = el('button', null, '删掉');
              del.onclick = function () {
                del.disabled = true;
                api('/persona/rule', { method: 'POST', body: { action: 'remove', rule: it.text } }).then(function (x) {
                  if (x && x.ok) { toast('已删掉这条规矩'); render(); } else { del.disabled = false; toast('删除失败'); }
                });
              };
              row.appendChild(del);
              c.appendChild(row);
              frag.appendChild(c);
            });
            var addBox = el('div', null);
            addBox.style.cssText = 'display:flex;gap:8px;align-items:center;margin:6px 0 2px;flex-wrap:wrap;';
            var ruleInput = document.createElement('input');
            ruleInput.type = 'text';
            ruleInput.placeholder = '写一条规矩(≤40 字,一条一事)…';
            ruleInput.style.cssText = 'flex:1;min-width:200px;padding:6px 10px;border:1px solid var(--lg-input);border-radius:9px;background:transparent;color:var(--lg-text);font-size:13px;';
            var addBtn = el('button', 'primary', '＋ 加进规矩');
            addBtn.onclick = function () {
              var text = ruleInput.value.trim();
              if (!text) return;
              addBtn.disabled = true;
              api('/persona/rule', { method: 'POST', body: { action: 'add', rule: text } }).then(function (x) {
                addBtn.disabled = false;
                if (x && x.ok) { toast('已加进规矩' + (x.warning === 'over-cap' ? '(超过建议上限,考虑合并)' : '')); render(); }
                else toast((x && x.message) || '未写入');
              }).catch(function () { addBtn.disabled = false; toast('网关不可达'); });
            };
            addBox.appendChild(ruleInput);
            addBox.appendChild(addBtn);
            frag.appendChild(addBox);

            // ② 习惯:只能由她提议 → 你确认
            // ①②习惯生成器的两个入口:数出来的(A)/ 想出来的(B)
            var genRow = el('div', 'btnrow');
            var bScan = el('button', null, '扫描纠正记录(零模型)');
            var bReflect = el('button', null, she('✨ 让她回想最近的相处'));
            var genOut = el('div', 'm-meta', '');
            genOut.style.cssText = 'margin:2px 0 8px;white-space:pre-wrap;line-height:1.7;';
            // 上一次生成的结果消息:**跨 render 保留**(render 会重建 DOM,否则"读了多少材料"一闪就没)
            var GEN_MSG_KEY = 'dsh-ling-habit-gen-msg';
            function takeGenMsg() { try { var v = sessionStorage.getItem(GEN_MSG_KEY) || ''; sessionStorage.removeItem(GEN_MSG_KEY); return v; } catch (e) { return ''; } }
            function keepGenMsg(v) { try { sessionStorage.setItem(GEN_MSG_KEY, String(v || '')); } catch (e) {} }
            var carried = takeGenMsg();
            if (carried) genOut.textContent = carried;
            function runGen(btn, path, busy) {
              btn.disabled = true;
              genOut.textContent = busy;
              keepGenMsg('');
              api(path, { method: 'POST', body: {} }).then(function (x) {
                btn.disabled = false;
                if (x && x.ok && x.found) {
                  var msg = x.message || ('新提出 ' + x.proposed + ' 条候选');
                  keepGenMsg(msg);            // 先存,render 之后还会显示
                  toast('新提出 ' + x.proposed + ' 条候选' + (x.skipped && x.skipped.length ? '(跳过 ' + x.skipped.length + ')' : ''));
                  render();
                } else if (x && x.ok) {
                  var msg2 = x.message || '没有新的候选。';
                  keepGenMsg(msg2);
                  genOut.textContent = msg2;
                  render();
                } else {
                  genOut.textContent = (x && x.message) || '失败';
                }
              }).catch(function () { btn.disabled = false; genOut.textContent = '网关不可达。'; });
            }
            bScan.onclick = function () { runGen(bScan, '/persona/habits/scan', '正在数你纠正过的次数…'); };
            bReflect.onclick = function () { runGen(bReflect, '/persona/habits/reflect', she('她在回想最近的相处…(一次模型调用)')); };
            genRow.appendChild(bScan); genRow.appendChild(bReflect);
            frag.appendChild(genRow);
            frag.appendChild(genOut);
            var pending = r.pending || [];
            var habits = r.habits || [];
            var pendMax = (r.caps && r.caps.pending) || 5;
            frag.appendChild(blockTitle(she('◈ 习惯(她长出来的 · 需你点头)')
              + (pending.length ? '(' + pending.length + '/' + pendMax + ' 条待确认)' : '')));
            // 满了要说明白:珍贵的东西不排队 —— 挡下新的,并告诉你为什么(2026-09-16 定案)
            if (pending.length >= pendMax) {
              frag.appendChild(el('div', 'm-meta', '待确认已经满了(' + pendMax + ' 条)—— 先把手上的处理完(认可 / 先不要),新的提议会被挡下。'));
            }
            if (!pending.length) frag.appendChild(el('div', 'm-empty', '暂无待确认的习惯提议。'));
            pending.forEach(function (p) {
              var c = card(p);
              var amended = p.amendedBy === 'ling';
              c.appendChild(el('div', null, p.text));
              c.appendChild(el('div', 'm-meta',
                (p.byUser
                  ? (amended ? she('你提议的 · 她建议改为上面这句,等你确认') : she('你提议的 · 等她回应(她下次会看到)'))
                  : she('她提议的 · 等你确认'))
                + (p.evidence ? ' · 依据:' + String(p.evidence).slice(0, 60) : '')));
              var row = el('div', 'btnrow');
              function resolve(action, btn) {
                btn.disabled = true;
                api('/persona/habit', { method: 'POST', body: { action: action, id: p.id } }).then(function (x) {
                  if (x && x.ok) { toast(action === 'confirm' ? '已认可这条习惯' : (action === 'reject' ? (p.byUser ? '已撤回' : '先不记了') : '已处理')); render(); }
                  else { btn.disabled = false; toast((x && x.reason) || '失败'); }
                });
              }
              if (p.byUser && !amended) {
                // 你刚提的:她还没表态 —— 只能由你撤回(收不收下是她的那一下)
                var wd = el('button', null, '撤回');
                wd.onclick = function () { resolve('reject', wd); };
                row.appendChild(wd);
              } else {
                var yes = el('button', 'primary', amended ? she('就按她说的来') : '认可这条习惯');
                var no = el('button', null, '先不要');
                yes.onclick = function () { resolve('confirm', yes); };
                no.onclick = function () { resolve('reject', no); };
                row.appendChild(yes); row.appendChild(no);
              }
              c.appendChild(row);
              if (amended && p.amendNote) c.appendChild(el('div', 'm-meta', she('她的话:') + String(p.amendNote).slice(0, 80)));
              frag.appendChild(c);
            });

            // ③ (已撤销)「你也可以提一条习惯等她回应」的入口 —— 2026-09-16 按用户判断撤掉:
            // 现实里没人会对朋友说"我向你提议一条习惯去养成",观感与"尽量少支配感、可有监护人的保护感"的主旨不符。
            // 后端通道(byUser 提议 + 注入面「待我回应」+ habit_resolve 工具)保留未删:将来若需要,放开这一处即可。
            // 已认可的习惯不在「建议中心」重复列出 —— 这里只做"待确认";查看在人格中心「习惯」栏(只读,删改走手术门)。
            frag.appendChild(el('div', 'm-meta', '已认可的习惯在人格中心「习惯」栏(只读;删改需先「🔓 对人格做手术…」解锁)。'));
          }).catch(function () {
            // 规矩区块失败不影响其它区块,但**必须可见**(静默失败查起来最贵)
            try {
              frag.appendChild(blockTitle('◈ 规矩 / 习惯'));
              frag.appendChild(el('div', 'm-empty', '规矩/习惯加载失败(网关不可达或宿主未重启)。'));
            } catch (e) { /* 提示本身不得影响其它区块 */ }
          });
        }

        function render() {
          body.textContent = '加载中…';
          var frag = document.createDocumentFragment();
          renderTiers(frag);
          // 1) 语料提炼建议
          api('/suggestions').then(function (sg) {
            if (!sg || !sg.ok) {
              body.textContent = '获取失败';
              return;
            }
            frag.appendChild(blockTitle('◈ 语料提炼(' + sg.items.length + ' 条待确认;已采纳 ' + sg.stats.adopted + ' / 忽略 ' + sg.stats.dismissed + ')'));
            if (!sg.items.length) {
              var empty = el('div', 'm-empty', '暂无 — 可在工具里重跑 tools/suggest-persona.mjs 重新提炼。');
              frag.appendChild(empty);
            }
            sg.items.forEach(function (it) {
              var c = card(it);
              c.appendChild(el('div', 'hint', '#' + it.id + ' · ' + (KIND_NAME[it.kind] || it.kind) + ' · ' + String(it.evidence.count || 0) + ' 次证据,最近 ' + String(it.evidence.recent || '').slice(0, 10)));
              c.appendChild(el('div', null, it.note));
              var evLine = '';
              if (it.evidence && it.evidence.samples && it.evidence.samples.length) {
                var s0 = it.evidence.samples[0];
                evLine = '例(' + String(s0.date || '').slice(0, 10) + '): ' + String(s0.excerpt || '').slice(0, 90);
                c.appendChild(el('div', 'm-meta', evLine));
              }
              var row = el('div', 'btnrow');
              var take = el('button', 'primary', '采纳');
              var drop = el('button', null, '忽略');
              function tryApply(unlock) {
                return api('/suggestions/apply', { method: 'POST', body: unlock ? { id: it.id, unlock: unlock } : { id: it.id } });
              }
              take.onclick = function () {
                take.disabled = true;
                tryApply(null).then(function (a) {
                  if (a && a.ok) {
                    toast('已采纳(' + (a.kindName || a.kind) + ' = ' + a.value + ');空闲会话已刷新');
                    render();
                    return;
                  }
                  if (a && a.reason === 'sealed' && (it.kind === 'aiName' || it.kind === 'userTitle')) {
                    // 定型门:自称/称呼属身份保护区 → 就地输入定型承诺句重试(惯例类不受限)
                    return lingAsk({
                      title: '定型门:' + (it.kind === 'aiName' ? '自称' : '称呼') + ' 建议需解锁',
                      body: '人格已定型。这条建议会改写' + (it.kind === 'aiName' ? '自称' : '对用户的称呼') + '(身份保护区)。\n\n请输入定型承诺句后重试(输入框禁粘贴,需手动输入)。规矩/习惯类建议不受此限制。',
                      placeholder: '手动输入定型承诺句…',
                      minLen: 10, noPaste: true, okLabel: '解锁并采纳',
                    }).then(function (v) {
                      if (!v) { take.disabled = false; return; }
                      return tryApply(v).then(function (a2) {
                        take.disabled = false;
                        if (a2 && a2.ok) {
                          toast('已解锁并采纳(' + (a2.kindName || a2.kind) + ' = ' + a2.value + ')');
                          render();
                        } else {
                          toast('仍失败:' + ((a2 && (a2.message || a2.reason)) || '未知'));
                        }
                      });
                    });
                  }
                  toast('采纳失败:' + ((a && (a.message || a.reason || a.error)) || '未知'));
                  take.disabled = false;
                }).catch(function () { take.disabled = false; toast('采纳失败(网关不可达)'); });
              };
              drop.onclick = function () {
                api('/suggestions/dismiss', { method: 'POST', body: { id: it.id } }).then(function () { render(); });
              };
              row.appendChild(take);
              row.appendChild(drop);
              c.appendChild(row);
              frag.appendChild(c);
            });
            // 2) 点踩成长建议
            frag.appendChild(blockTitle('◈ 平台点踩反馈'));
            return api('/feedback');
          }).then(function (r) {
            if (!r || !r.ok) return;
            if (!r.items.length) {
              var e = el('div', 'm-empty', '暂无待确认(已采纳 ' + r.stats.applied + ' · 忽略 ' + r.stats.dismissed + ')。用法:回复上点踩并填理由。');
              frag.appendChild(e);
            } else {
              r.items.forEach(function (it) {
                var c = card(it);
                c.appendChild(el('div', 'hint', '#' + it.id + ' · 会话 ' + String(it.session_id || '').slice(0, 8)));
                c.appendChild(el('div', null, it.note));
                var row = el('div', 'btnrow');
                var take = el('button', 'primary', '认可这条习惯');
                var drop = el('button', null, '忽略');
                take.onclick = function () {
                  api('/feedback/apply', { method: 'POST', body: { id: it.id } }).then(function (a) {
                    toast(a && a.ok ? '已认可为习惯(共 ' + (a.habits ?? '?') + ' 条)' : ('采纳失败:' + ((a && a.reason) || '')));
                    render();
                  });
                };
                drop.onclick = function () {
                  api('/feedback/dismiss', { method: 'POST', body: { id: it.id } }).then(function () { render(); });
                };
                row.appendChild(take);
                row.appendChild(drop);
                c.appendChild(row);
                frag.appendChild(c);
              });
            }
            body.textContent = '';
            body.appendChild(frag);
          }).catch(function () { body.textContent = '网关不可达'; });
        }
        render();
      }

      // ---------------- React component (store-kind aware) ----------------
      function mount(store) {
        if (!React) return null;
        var h = React.createElement;
        var useEffect = React.useEffect;
        var useRef = React.useRef || function () { return { current: null }; };
        var useState = React.useState || function (v) { return [v, function () {}]; };

        function LingButton(props) {
          var isGlobal = store.get().kind === 'global';
          var sidFromProps = (!isGlobal && props && (props.sessionId || props.runtimeSessionId)) || null;
          var st = store.get();
          if (sidFromProps && st.sessionId !== sidFromProps) store.set({ sessionId: sidFromProps });
          var btnRef = useRef(null);
          var hoverTimer = useRef(null);
          var bump = useState(0)[1];

          useEffect(function () {
            var unsub = store.subscribe(function () { bump(function (x) { return x + 1; }); });
            var timer = setInterval(function () {
              api(pollPath(store)).then(function (r) { applyStateToStore(store, r); }).catch(function () {});
            }, 3000);
            return function () {
              unsub();
              clearInterval(timer);
              if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
            };
          }, []);

          function clearHover() {
            if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
          }

          st = store.get();
          var mode = st.mode || 'life';
          // 侧栏窄轨(收起)时官方只给极窄的一格:按 { wide } 切换为方图标态,避免溢出
          var rail = !!(props && props.wide === false);
          var label = rail
            ? (mode === 'work' ? '⚙' : '☾')
            : (mode === 'work' ? '⚙ 工作' : '☾ 生活');
          var title = isGlobal
            ? ('器灵默认模式:' + modeName(mode) + '(新会话跟随)。左键切换;悬停 1.5s 菜单。进入会话后请用右上角按钮切换该会话')
            : ('器灵 · ' + (st.running ? '运行中(冻结):' : '') + '左键切换为' + modeName(otherMode(mode)) + '模式;悬停 1.5 秒打开菜单');
          return h('button', {
            ref: btnRef,
            className: 'dsh-ling-btn' + (isGlobal ? ' dim' : '') + (rail ? ' rail' : ''),
            title: title,
            'aria-label': '器灵控制器:' + (isGlobal ? '默认' : '当前') + modeName(mode) + '模式',
            onClick: function () { clearHover(); toggleMode(store); },
            onMouseEnter: function () {
              clearHover();
              hoverTimer.current = setTimeout(function () {
                hoverTimer.current = null;
                var node = btnRef && btnRef.current;
                openMenuNear(node ? node.getBoundingClientRect() : null, store);
              }, HOVER_MS);
            },
            onMouseLeave: clearHover,
            onMouseDown: clearHover,
            onContextMenu: function (e) {
              if (e && e.preventDefault) e.preventDefault();
              if (e && e.stopPropagation) e.stopPropagation();
            },
            onKeyDown: function (e) {
              if (e.key === 'Enter' && !e.shiftKey) { clearHover(); toggleMode(store); }
              else if (e.key === 'Enter' && e.shiftKey) {
                var node = btnRef && btnRef.current;
                openMenuNear(node ? node.getBoundingClientRect() : null, store);
              }
            },
          }, label);
        }
        return LingButton;
      }

      // -------- 右侧栏面板:器灵 · 复盘模式(D9-b,2026-09-20) --------
      // 侧栏是"左对话、右状态"的复盘位:对话在左,树与待办在右。
      // 注册分两阶段(官方契约):① sidebarRightTabs.register 声明类型;② keyed 槽 sidebar.right.pane.tab 供正文。
      // 两个坑必须避开:key 必须 === definition.id(不是 kind);
      // 必须等服务 provide 后再注册 —— 用槽声明触发注册会永久失败(官方 seat 先 declare 槽、后 provide 服务)。
      var LING_REVIEW_ID = 'dsh-ling:review';
      var LING_REVIEW_KIND = 'ling-review';
      var lingCtx = null; // apply 时赋值,供"打开侧栏"按钮使用

      /** 把树拍平成 [节点,深度](侧栏窄,不做递归组件)。 */
      function reviewFlat(td) {
        var out = [];
        (function walk(list, d) {
          (list || []).forEach(function (n) {
            out.push({ n: n, d: d });
            walk(n.children, d + 1);
          });
        })((td && td.roots) || [], 0);
        return out;
      }

      /** 复盘开场材料(侧栏版:不依赖记忆中心的 st)。 */
      function reviewPromptOf(td, conf) {
        var flat = reviewFlat(td);
        var pend = (conf || []).filter(function (c) { return c.status === 'pending'; });
        var out = ['我们现在做一次记忆树复盘。', '', '【当前树】共 ' + flat.length + ' 个节点'];
        flat.forEach(function (x) {
          out.push(new Array(x.d + 1).join('  ') + '- ' + (x.n.name || x.n.id)
            + ' —— ' + x.n.memories + ' 条记忆 / ' + x.n.sessions + ' 个会话');
        });
        out.push('');
        out.push('【待处理矛盾】' + (pend.length ? pend.length + ' 条' : '暂无'));
        pend.slice(0, 12).forEach(function (c) {
          out.push('- 「' + (c.aTitle || '?') + '」 ⟷ 「' + (c.bTitle || '?') + '」（' + c.kind + '）');
        });
        out.push('');
        out.push('请你先说出你看到的树的结构问题:哪些枝该并到一起、哪些该连边、哪些该改名;矛盾该以哪条为准。');
        out.push('我会逐条对齐 —— 你也可以纠正我。');
        return out.join('\n');
      }

      /** 复盘解锁:跨面板共享的真值 —— 记忆中心与右侧复盘栏读同一个变量(用户 2026-09-21)。
       *  「复盘模式」不是一个 UI 开关,而是"左会话 + 右侧栏"这个状态;树编辑解锁只是它的附属。*/
      var lingUnlocked = false;
      /** 解锁状态订阅者(2026-09-22 审计 C#3):侧栏是 React 组件,useState 只在**首次渲染**取值,
       *  记忆中心改 lingUnlocked 后它不会重渲染 ⇒ 出现"点了「🌱 开始复盘」但侧栏仍显示锁定"。
       *  用最简订阅模式:本模块持有订阅者,setLingUnlocked 时逐个通知。 */
      var lingUnlockSubs = [];
      /**
       * 记忆中心 ↔ 复盘入口 的数据同步钩子(2026-09-22)。
       * 记忆中心的 st 是**面板函数内的局部变量**,模块级函数访问不到它 —— 上一版 startReviewFromMenu
       * 直接写 st.treeData 会抛 ReferenceError,被外层 catch 吞成「准备复盘材料失败(网关)」。
       * 正解:由面板注册钩子,入口通过钩子间接同步(顺带解决"记忆中心的树不跟着刷新")。
       */
      var lingCenterSync = null;
var lingCenterReload = null;   // 侧栏改完树后通知记忆中心重载(两侧同源,2026-09-22)
      function setLingUnlocked(v, silent) {
        lingUnlocked = !!v;
        for (var i = 0; i < lingUnlockSubs.length; i += 1) {
          try { lingUnlockSubs[i](lingUnlocked); } catch (e) {
          // 审计 C#17:这里曾把 ReferenceError/TypeError 一起吞掉 —— 订阅者内部写错变量名时
          // 表现只是"解锁状态没同步",极难定位。至少把真实异常打到 console。
          console.warn('[dsh-ling] 解锁状态订阅者抛错', e);
        }
        }
        if (!silent) {
          toast(lingUnlocked
            ? '复盘已开始 —— 树编辑解锁(每步留痕);右侧栏看状态,左会话讨论'
            : '复盘已结束 —— 树结构回到只读');
        }
      }

      /**
       * 复制文本(clipboard 不可用时回退 execCommand)。
       * silent=true 时不再单独 toast「已复制」—— 调用方自己会报一句完整的结果,
       * 否则会出现两个 toast 叠加(2026-09-22 用户实测:『已复制复盘开场白 —— 已复制 …』)。
       */
      function reviewCopy(text, silent) {
        // 审计 C#13:改成**回报是否成功**(Promise) —— clipboard 是异步的,只有 `.then` 才知道结果;
        // 旧实现不看结果就让调用方宣称"已复制",而浏览器完全可能拒绝(非用户手势 / 无权限)。
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).then(
              function () { if (!silent) toast('已复制'); return true; },
              function () { return reviewCopyFallback(text, silent); },
            );
          }
        } catch (e) { /* fallthrough */ }
        return Promise.resolve(reviewCopyFallback(text, silent));
      }
      function reviewCopyFallback(text, silent) {
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;left:-9999px;';
          document.body.appendChild(ta);
          ta.select();
          var ok = document.execCommand('copy');
          document.body.removeChild(ta);
          if (!silent) toast('已复制');
          return ok !== false;
        } catch (e) {
          toast('复制失败 —— 请手动选中');
          return false;
        }
      }

      /** 侧栏正文组件。React 不可用时返回 null 而非崩溃。 */
      function LingReviewBody() {
        if (!React) return null;
        var h = React.createElement;
        var s1 = React.useState(null);
        var data = s1[0];
        var setData = s1[1];
        var s2 = React.useState(0);
        var nonce = s2[0];
        var setNonce = s2[1];
        // 侧栏操作完成后的统一刷新:侧栏自身 + 记忆中心(两侧同源,2026-09-22)
        function sideReload() {
          s2[1](function (n) { return n + 1; });
          if (lingCenterReload) {
          try { lingCenterReload(); } catch (e) {
            // 审计 C#17:同 lingUnlockSubs —— 钩子是跨面板调用,吞异常会让"侧栏改了但记忆中心没跟着更新"
            // 变成一个没有任何线索的现象。
            console.warn('[dsh-ling] 记忆中心重载钩子抛错', e);
          }
        }
        }
        // 复盘解锁开关(与记忆中心共享 lingUnlocked):侧栏才是"复盘状态"的所在地。
        var s3 = React.useState(lingUnlocked);
        var unlocked = s3[0];
        var setUnlocked = s3[1];
        // 审计 C#3:订阅模块级解锁状态 —— 否则记忆中心点「🌱 开始复盘」后,本面板的 useState
        // 仍是首次渲染时的旧值,界面继续显示"锁定",与真实状态不符。
        React.useEffect(function () {
          var fn = function (v) { s3[1](v); };
          lingUnlockSubs.push(fn);
          return function () {
            var i = lingUnlockSubs.indexOf(fn);
            if (i >= 0) lingUnlockSubs.splice(i, 1);
          };
        }, []);
        // 选中态统一(2026-09-22 用户):单选与多选共用 s8 的集合,selId 由它派生。
        // 原先 selId(蓝) 与 dragIds(橙) 是两套状态,表现为"一蓝一橙"且拖动只有橙的会动。
        var refName = React.useRef(null);
        var refRep = React.useRef(null);
        var refRepNew = React.useRef(null);
        var refW = React.useRef(null);
        var refLk = React.useRef(null);
        var refLkNote = React.useRef(null);
        var refVein = React.useRef(null);
        // R1 树的保存/恢复:快照列表(侧栏是操作台,故快照入口也在这里)
        var s5 = React.useState([]);
        var snapshots = s5[0];
        var setSnapshots = s5[1];
        var refSnap = React.useRef(null);
        // R2 会话级展开:哪些枝展开了、该枝的成员缓存(懒加载)
        // C(2026-09-25 用户):此前 openId 是**单个字符串** ⇒ 打开一个就把上一个关掉(独占式)。
        // 复盘的场景恰恰是"同时对照几条枝",独占等于逼人来回点。改用集合(每节点独立),
        // 可同时展开多个;Shift+C 一键全折叠(见下方 keydown effect)。
        var s6 = React.useState({});
        var openIds = s6[0];
        var setOpenIds = s6[1];
        var s7 = React.useState({});
        var memberMap = s7[0];
        var setMemberMap = s7[1];
        // 审计 C#10:成员读取失败的枝 id → 错误信息(原先失败被 `.catch(noop)` 吞掉,
        // 该节点永远停在「读取中…」,看起来像卡死,实际请求早就结束了)。
        var s7b = React.useState({});
        var memberFail = s7b[0];
        var setMemberFail = s7b[1];
        // 选中集合(单选/多选共用同一个):拖动时整个集合一起动,高亮只有一种颜色。
        var s8 = React.useState([]);
        var dragIds = s8[0];
        var setDragIds = s8[1];
        // 拖动悬停目标:松手前就给出"会落到哪"的预提示(青色虚线框)
        var s9 = React.useState('');
        var dropTarget = s9[0];
        var setDropTarget = s9[1];
        // 审计 C#4:本次拖动的**来源枝 id**。会话条目的 id 只有 `conv|<source>|<convId>`,
        // 不含"我原来在哪条枝" —— 所以必须在 onDragStart 时记下它所属的枝,
        // 否则落库前的撤回信息里记不到这一项 ⇒ Ctrl+Z 报「已撤回:恢复了 0 项的位置」。
        // 用 ref 而不是 state:拖拽期间不需要重渲染,drop 时读最新值即可。
        var refDragFrom = React.useRef('');
        // 滚动位置自保(2026-09-22 用户:点主脉级会跳回顶部)
        // 点选节点会触发整块重渲染,内容高度变化时浏览器会把视口弹回顶部;
        // 故实时记录 scrollTop,并在每次渲染后恢复 —— 与记忆中心 st.treeScroll 同思路。
        var boxRef = React.useRef(null);
        var sScroll = React.useRef(0);
        React.useEffect(function () {
          var el = boxRef.current;
          if (el && sScroll.current) el.scrollTop = sScroll.current;
        });
        // 编辑区只在"恰好选中一个"时生效(多选时显示提示)
        var selId = (dragIds.length === 1) ? dragIds[0] : '';
        // 复盘守门(2026-09-22 用户:「互相复盘不应该被我绕过,动记忆树不能是随意的」):
        // 记录"自器灵上次开口以来累积了多少笔结构改动还没交代"。未同步时:
        // ① 面板顶部红字提示 ② **拦住"退出复盘模式"** —— 改完树必须让器灵有机会看到。
        var s10 = React.useState(0);
        var pendingChanges = s10[0];
        var setPendingChanges = s10[1];
        // R7 主脉提炼(2026-09-23):候选队列。设计稿 §5 —— 提炼结果**先进审核队列**,
        // 采纳后才写入主脉自己的记忆(conv_overview source='vein'),且带派生来源。
        var s11 = React.useState([]);
        var veinSugs = s11[0];
        var setVeinSugs = s11[1];
        React.useEffect(function () {
          var alive = true;
          Promise.all([
            api('/tree').catch(function () { return null; }),
            api('/conflicts').catch(function () { return null; }),
            api('/branch-log?limit=6').catch(function () { return null; }),
            api('/tree/snapshots?limit=30').catch(function () { return null; }),
            api('/branch-log/pending').catch(function () { return null; }),
            api('/vein/suggestions?status=new&limit=20').catch(function () { return null; }),
          ]).then(function (rs) {
            if (!alive) return;
            setSnapshots((rs[3] && rs[3].ok) ? (rs[3].snapshots || []) : []);
            setPendingChanges((rs[4] && rs[4].ok) ? Number(rs[4].pending || 0) : 0);
            setVeinSugs((rs[5] && rs[5].ok) ? (rs[5].suggestions || []) : []);
            setData({
              tree: (rs[0] && rs[0].ok) ? rs[0] : null,
              conflicts: (rs[1] && rs[1].ok) ? (rs[1].conflicts || []) : [],
              log: (rs[2] && rs[2].ok) ? (rs[2].log || []) : [],
            });
          });
          return function () { alive = false; };
        }, [nonce]);
        // 复盘守门(2026-09-23 修):pending 是**服务端事实**,但"主人发言"不会触发本面板重载
        // (只有侧栏自己的操作才会 push nonce) ⇒ 显示值会滞后于真相:器灵已经开口看到改动了,
        // 侧栏还写着"有 N 笔没说"。加轻量轮询让它跟上(8s 一次小请求,值不变时 React 不重渲染)。
        React.useEffect(function () {
          var t = setInterval(function () {
            api('/branch-log/pending').then(function (r) {
              if (r && r.ok) setPendingChanges(Number(r.pending || 0));
            }).catch(function () { /* 轮询失败不影响复盘 */ });
          }, 8000);
          return function () { clearInterval(t); };
        }, []);
        // Shift+C:一键折叠所有已展开的枝(2026-09-25 用户定,暂定键位)。
        // ⚠️ 位置纪律:必须落在**本函数所有 early return 之前**(下方有 `if (!data) return …`)。
        // React 要求每次渲染的 hook 数量与顺序恒定;把 useEffect 放在 early return 之后会出现
        // "首次渲染 data 为空 → 提前 return(少一个 hook) → 数据到达后重渲染多一个 hook"
        // ⇒ React error #310(Rendered more hooks than during the previous render),整块面板崩掉。
        // 这个坑 2026-09-25 深夜实际踩过一次(侧栏「器灵·复盘」全黑),别再挪下去。
        // 只收折叠、不碰选中、**不清 memberMap** —— 再展开时直接用缓存,不必重新拉一遍。
        // 输入框里按 Shift+C 是打大写 C,必须放行(否则主人打不出"CAD"这类词)。
        React.useEffect(function () {
          var onKey = function (e) {
            if (!e || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
            if (String(e.key || '').toLowerCase() !== 'c') return;
            var t = e.target;
            var tag = (t && t.tagName) ? String(t.tagName).toLowerCase() : '';
            if (tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable)) return;
            setOpenIds({});
          };
          window.addEventListener('keydown', onKey, true);
          return function () { window.removeEventListener('keydown', onKey, true); };
        }, []);
        // 让本面板自己成为滚动容器(2026-09-22):
        // 之前滚动发生在平台的祖先容器上 → 每次重渲染(点选一个节点)都会把视口弹回顶部;
        // 把 overflow 收到自己身上后,React 复用同一个 DOM 节点,滚动位置天然保留。
        var box = {
          padding: '8px 10px', fontSize: '12px', lineHeight: '1.75',
          height: '100%', maxHeight: '100%', boxSizing: 'border-box',
          overflowY: 'auto', overflowX: 'hidden',
        };
        if (!data) return h('div', { style: box }, '正在读取记忆树…');
        var flat = reviewFlat(data.tree);
        var pend = data.conflicts.filter(function (c) { return c.status === 'pending'; });
        // ---- R2 会话级展开:懒加载某枝的成员(会话/历史条目) ----
        // 审计 C#10:loadMembers(id, force) —— force=true 时忽略"已失败"标记重试。
        function loadMembers(id, force) {
          if (!force && memberMap[id]) return;                 // 已缓存的成功结果,直接用
          if (!force && memberFail[id] !== undefined) return;  // 已失败过,等主人点「重试」,不反复打网关
          api('/branch/members?id=' + encodeURIComponent(id)).then(function (r) {
            if (r && r.ok) {
              setMemberFail(function (m) { var o = Object.assign({}, m); delete o[id]; return o; });
              setMemberMap(function (m) { var o = Object.assign({}, m); o[id] = r.members || []; return o; });
            } else {
              // 200 但 ok=false(枝不存在等):同样要标记,否则也是永远「读取中…」
              setMemberFail(function (m) {
                var o = Object.assign({}, m); o[id] = (r && r.reason) || '读取失败'; return o;
              });
            }
          }).catch(function (e) {
            console.warn('[dsh-ling] 读取枝成员失败', id, e);
            setMemberFail(function (m) {
              var o = Object.assign({}, m); o[id] = (e && e.message) || '网关不可达'; return o;
            });
          });
        }
        function toggleOpen(id) {
          var wasOpen = !!openIds[id];
          setOpenIds(function (m) {
            var o = Object.assign({}, m);
            if (wasOpen) delete o[id]; else o[id] = 1;
            return o;
          });
          if (!wasOpen) loadMembers(id, false);
        }
        // (Shift+C 的 keydown effect 已上移到本函数顶部 —— 必须在 early return 之前,
        //  否则 React error #310。详见上方"位置纪律"注释。)
        // ---- R3 拖动:move = 改归属;Alt+拖 = 连边(归属不变) ----
        // id 形态两种:枝 = `br:xxx` / `trunk`;会话条目 = `conv|<source>|<convId>`(用 | 分隔,
        // 因为 import 源的 convId 自带 `import:` 前缀、含冒号)。
        /** 审计 C#5:会话条目所属的枝(由渲染它的那一行传入,就是所在枝 id)。 */
        function convOwner(id) {
          var p = String(id).split('|');
          return p[2] || '';
        }
        /** 审计 C#16 同批:同步抛错也当成一次"失败结果",而不是让整批地图在这里断掉。 */
        function safeApi(fn) {
          try { return fn(); }
          catch (e) { return Promise.reject(e); }
        }
        function sideDrop(ids, targetId, isLink, fromId) {
          // 审计 C#4:会话条目记原位置**必须**知道它原来属于哪条枝(fromId)。原先只有
          // 「另一条会话行」的 onDrop 传了 fromId,而**拖到枝行**那个最常用的落点没传 ⇒
          // prev 里根本没有这一项 ⇒ Ctrl+Z 报「已撤回:恢复了 0 项的位置」。
          // 现在拖拽源在 onDragStart 就存进 ref,所有落点统一传过来。
          if (!targetId) { toast('落点不明(这条枝没有 id)—— 请换一个目标'); return; }
          var prev = [];
          var skipped = [];
          var moves = ids.filter(function (z) {
            if (z.indexOf('conv|') === 0) {
              var owner = fromId || convOwner(z);
              // 已经在这条枝下 = 自赋值:后端照样返回 ok,但归属其实没变,
              // 不该报"已移动",也不该记进撤回栈(撤回了也什么都没发生)。
              if (!isLink && owner && owner === targetId) { skipped.push(z); return false; }
              if (!owner) { skipped.push(z); return false; }
              prev.push({ conv: z, branchId: owner });
              return true;
            }
            if (!isLink && z === targetId) { skipped.push(z); return false; }
            var hit = 'trunk';
            flat.forEach(function (x) { if (x.n.id === z) hit = x.n.parentId || 'trunk'; });
            prev.push({ id: z, parentId: hit });
            return true;
          });
          if (!moves.length) {
            toast(isLink ? '这几项都已经连过了' : '它们已经在这条枝下了 —— 没动');
            return;
          }
          undoStack = [{ prev: prev, link: !!isLink }]; // 撤回信息必须在落库前记
          var tasks = moves.map(function (z) {
            if (z.indexOf('conv|') === 0) {
              var p = z.split('|');
              return safeApi(function () {
                return api('/branch/assign', { method: 'POST', body: { source: p[1], convId: p[2], branchId: targetId } });
              });
            }
            if (isLink) {
              return safeApi(function () {
                return api('/veins/link', { method: 'POST', body: { from: z, to: targetId, kind: 'related', note: '拖动连边' } });
              });
            }
            return safeApi(function () {
              return api('/branches/reparent', { method: 'POST', body: { id: z, parentId: targetId } });
            });
          });
          Promise.all(tasks).then(function (rs) {
            // 审计 C#11:`Promise.all` 只统计"几个成功"就报成功 —— 部分失败时主人不知道
            // 到底哪几条没落库。现在:按结果把**成功的那几条**记进撤回栈(失败的不记,
            // 否则撤回会去"恢复"一个从没移动过的项),并把失败条数如实报出来。
            var okRs = rs.filter(function (r) { return r && r.ok; });
            var bad = rs.filter(function (r) { return !r || !r.ok; });
            undoStack = [{ prev: prev.filter(function (p, i) { return !!(rs[i] && rs[i].ok); }), link: !!isLink }];
            if (!undoStack[0].prev.length) undoStack = [];
            var extra = skipped.length ? (' · ' + skipped.length + ' 项已在该枝下,没动') : '';
            if (bad.length) {
              toast((isLink ? '⚠ 连边 ' : '⚠ 移动 ') + okRs.length + '/' + moves.length
                + ' 项成功,' + bad.length + ' 项失败:' + ((bad[0] && bad[0].reason) || (bad[0] && bad[0].error) || '未知') + extra);
            } else {
              toast((isLink ? '已连边 ' : '已移动 ') + okRs.length + ' 项(Ctrl+Z 可撤回一步)' + extra);
            }
            setDragIds([]); setOpenIds({}); setMemberMap({});
            // 审计 C#11:无论成败都刷新 —— 否则"部分失败"时界面还停在拖动前的样子,
            // 主人以为都没落库,实际有几条已经改了归属。
            sideReload();
          }).catch(function (e) {
            console.warn('[dsh-ling] 拖动落库失败', e);
            toast('✗ 拖动失败:' + ((e && e.message) || '未知'));
            sideReload();
          });
        }
        var undoStack = [];
        function sideUndo() {
          if (!undoStack.length) { toast('没有可撤回的操作'); return; }
          var u = undoStack.pop();
          undoStack = [];
          if (u.link) { toast('连边已生效 —— 要断边请到「横向连边」列表点断边'); return; }
          var tasks = u.prev.map(function (p) {
            if (p.conv) {
              var q = p.conv.split('|');
              return safeApi(function () {
                return api('/branch/assign', { method: 'POST', body: { source: q[1], convId: q[2], branchId: p.branchId } });
              });
            }
            return safeApi(function () {
              return api('/branches/reparent', { method: 'POST', body: { id: p.id, parentId: p.parentId } });
            });
          });
          Promise.all(tasks).then(function (rs) {
            var ok = rs.filter(function (r) { return r && r.ok; }).length;
            toast(ok === u.prev.length
              ? ('已撤回:恢复了 ' + ok + ' 项的位置')
              : ('⚠ 撤回只成功 ' + ok + '/' + u.prev.length + ' 项 —— 剩下的请手动改回'));
            setDragIds([]); sideReload();
          }).catch(function (e) {
            console.warn('[dsh-ling] 撤回失败', e);
            toast('✗ 撤回失败:' + ((e && e.message) || '未知'));
          });
        }
        // ---- R1 树的保存 / 恢复 ----
        function restoreSnapshot(s) {
          // 不弹确认:恢复前服务端会**自动把当前状态存成一份快照**,所以恢复本身也是可撤的
          api('/tree/restore', { method: 'POST', body: { id: s.id } }).then(function (r) {
            toast(r && r.ok
              ? ('已恢复到 #' + s.id + (r.backupId ? ' —— 当前状态已自动备份为 #' + r.backupId + ',可再撤回来' : ''))
              : ('✗ ' + ((r && r.reason) || '恢复失败')));
            setOpenIds({}); setMemberMap({});
            sideReload();
          }).catch(function (e) { toast('✗ 恢复失败:' + ((e && e.message) || '')); });
        }
        // 快照删除失败的 reason → 中文。后端 deleteTreeSnapshot 会返回内部标识
        // (bad-id / not-found / last-auto / db),直接拼进 toast 会把 'last-auto' 这种
        // 英文内部码露给主人 —— 尤其「最后一份自动备份不能删」是**保护性拒绝**,
        // 必须让人看懂"为什么不让删",否则看起来像坏了。后端若已带 message 就优先用它。
        var SNAP_DEL_REASON = {
          'bad-id': '快照 id 不对',
          'not-found': '快照不存在(可能已经被删掉了)',
          'last-auto': '这是最后一份自动备份,不能删 —— 它是「恢复上一次树结构」的撤回路径',
          'db': '记忆库写入错误',
        };
        function snapDelReason(r) {
          if (r && r.message) return String(r.message);
          var code = r && r.reason;
          if (!code) return '未知(网关没给原因)';
          return SNAP_DEL_REASON[code] || String(code);
        }
        function delSnapshot(id) {
          api('/tree/snapshot/delete', { method: 'POST', body: { id: id } })
            .then(function (r) {
              // 审计 C#6:旧实现完全不读 r.ok ⇒ 删除失败(不存在 / db 错)也报「已删除」。
              if (!r || !r.ok) { toast('✗ 删除快照 #' + id + ' 失败:' + snapDelReason(r)); return; }
              toast('已删除快照 #' + id); sideReload();
            })
            .catch(function (e) {
              console.warn('[dsh-ling] 删除快照失败', id, e);
              toast('✗ 删除快照 #' + id + ' 失败:' + ((e && e.message) || '网关不可达'));
            });
        }
        var sIn = { padding: '3px 6px', fontSize: '12px', background: '#12161f', color: '#e6e9ef', border: '1px solid var(--lg-border)', borderRadius: '6px' };
        var kids = [];
        kids.push(h('div', { key: 'hd', style: { fontWeight: 700, marginBottom: '2px' } }, '器灵 · 复盘模式'));
        kids.push(h('div', { key: 'hint', style: { opacity: 0.7, marginBottom: '8px' } },
          '左边会话讨论复盘,这里是操作台:点节点选中后可改名 / 并脉 / 连边 / 调权重(需先解锁)。'));
        kids.push(h('div', { key: 'th', style: { fontWeight: 700, margin: '6px 0 2px' } },
          '记忆树 · ' + flat.length + ' 个节点'));
        // 连边可视化:linkFrom/linkTo 原本定义在记忆中心面板函数内(本组件作用域取不到),
        // 这里是同值副本;allLinks 来自 /tree 的 links。
        var linkA = function (l) { return String(l.fromBranch || l.from_branch || l.from || ''); };
        var linkB = function (l) { return String(l.toBranch || l.to_branch || l.to || ''); };
        var allLinks = (data.tree && data.tree.links) || [];
        var nameOf = function (id) {
          for (var q = 0; q < flat.length; q++) { if (flat[q].n.id === id) return flat[q].n.name || id; }
          return id;
        };
        // 审计 C#14(口径不一):树最多渲染多少行、以及"还有 N 个节点"怎么算,必须用**同一个数**。
        // 旧写法渲染 `flat.slice(0, 400)` 却提示 `flat.length - 40` —— 41~400 个节点时提示
        // "还有 1~360 个节点"而它们其实**已经画在下面了**,等于骗主人去翻不存在的节点。
        var SIDE_TREE_MAX = 400;
        flat.slice(0, SIDE_TREE_MAX).forEach(function (x, i) {
          var on = dragIds.indexOf(x.n.id) >= 0;
          var isOpen = !!openIds[x.n.id];
          var dragOn = on;
          var mem = memberMap[x.n.id] || null;
          var hasKids = (Number(x.n.sessions) > 0) || (Number(x.n.memories) > 0);
          kids.push(h('div', {
            key: 'n' + i,
            draggable: true,
            title: 'Ctrl+点 = 多选;拖动 = 换归属;Alt+拖动 = 只连边;Ctrl+Z 撤回一步',
            onClick: function (ev) {
              if (ev.ctrlKey || ev.metaKey) {
                setDragIds(function (ids) {
                  var k = ids.indexOf(x.n.id);
                  return k >= 0 ? ids.filter(function (z) { return z !== x.n.id; }) : ids.concat([x.n.id]);
                });
                return;
              }
              // 无 Ctrl:清空重选(点已选中的那一个 = 取消);Ctrl:加选/减选
              setDragIds(on ? [] : [x.n.id]);
            },
            onDragStart: function (ev) {
              var ids = (dragOn && dragIds.length) ? dragIds.slice() : [x.n.id];
              setDragIds(ids);
              // 审计 C#4:拖动枝本身时来源枝 = 它现在的父节点(撤回用)
              refDragFrom.current = x.n.parentId || 'trunk';
              try { ev.dataTransfer.setData('text/plain', ids.join(',')); ev.dataTransfer.effectAllowed = 'move'; } catch (e) { /* noop */ }
            },
            onDragEnd: function () { refDragFrom.current = ''; },
            onDragOver: function (ev) {
              if (dragIds.indexOf(x.n.id) >= 0) return;
              ev.preventDefault();
              if (dropTarget !== x.n.id) setDropTarget(x.n.id);
              try { ev.dataTransfer.dropEffect = ev.altKey ? 'link' : 'move'; } catch (e) { /* noop */ }
            },
            onDragLeave: function () { if (dropTarget === x.n.id) setDropTarget(''); },
            onDrop: function (ev) {
              ev.preventDefault();
              setDropTarget('');
              var ids = dragIds.filter(function (z) { return z !== x.n.id; });
              if (!ids.length) return;
              if (!unlocked) { toast('🔒 先点「🔒 进入复盘模式」再拖动'); return; }
              // 审计 C#4:把来源枝一并传下去 —— 会话条目全靠它才能记进撤回栈。
              // 拖枝自己的时候来源是 refDragFrom,也从这里统一传,语义一致。
              sideDrop(ids, x.n.id, ev.altKey, refDragFrom.current || '');
            },
            style: {
              paddingLeft: (x.d * 12) + 'px',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              cursor: 'grab', borderRadius: '5px',
              // 抑制原生文本选择:Alt+拖动在无此声明时会被浏览器当成"选择文字",把我们的选中/拖拽高亮盖掉
              userSelect: 'none', WebkitUserSelect: 'none',
              // 选中色只有一种(琥珀) —— 单选与 Ctrl 多选视觉一致,避免"一蓝一橙"
              background: on ? 'rgba(197,139,47,.22)' : 'transparent',
              // 拖动悬停目标:青色虚线框,松手前就知道会落到哪(2026-09-22 用户)
              outline: (dropTarget === x.n.id) ? '2px dashed #3fb9a6'
                : (on ? '1px solid rgba(197,139,47,.5)' : 'none'),
              outlineOffset: '-2px',
            },
          },
          h('span', {
            key: 'tg',
            onClick: function (ev) {
              ev.stopPropagation();
              if (!hasKids) return;
              toggleOpen(x.n.id);
            },
            style: { display: 'inline-block', width: '12px', opacity: hasKids ? 0.75 : 0.25 },
          }, hasKids ? (isOpen ? '▾' : '▸') : '·'),
          // A(2026-09-25 用户):主脉与枝此前在列表里长得一模一样,只能靠"点开会显示 [主脉]"
          // 分辨 —— 而「零散记录」(枝) 与「零散会话」(主脉) 这类名字只差一个字,必然选错。
          // 现在行首给标记:🌱 主干 / ◆ 主脉 / · 枝。
          (x.n.kind === 'trunk' ? '🌱 ' : (x.n.kind === 'vein' ? '◆ ' : '· ')) + (x.n.name || x.n.id)
            + '  ' + x.n.memories + '/' + x.n.sessions,
          (function () {
            var k = 0;
            allLinks.forEach(function (l) { if (linkA(l) === x.n.id || linkB(l) === x.n.id) k++; });
            return k ? h('span', { key: 'lv', style: { color: '#c58b2f', fontSize: '11px' } }, '  ↔' + k) : null;
          })()));
          // 连边清单已移到"已选"编辑区(2026-09-22):
          // 留在树上会在点选不同节点时不断累加,把行高撑乱 —— 见编辑区的 selLinks。
          if (isOpen) {
            var memErr = memberFail[x.n.id];
            if (memErr !== undefined) {
              // 审计 C#10:失败要看得见 —— 显示真实原因,并给一个「重试」入口(点击只重拉这一枝)
              kids.push(h('div', {
                key: 'nf' + i,
                style: { paddingLeft: ((x.d + 1) * 12 + 12) + 'px', opacity: 0.7, color: '#e05555' },
              }, '⚠ 会话列表读取失败(' + String(memErr) + ')',
              h('span', {
                key: 'rt',
                style: { marginLeft: '6px', color: '#c58b2f', cursor: 'pointer', textDecoration: 'underline' },
                onClick: function (ev) { ev.stopPropagation(); loadMembers(x.n.id, true); },
              }, '重试')));
            } else if (!mem) {
              kids.push(h('div', { key: 'nl' + i, style: { paddingLeft: ((x.d + 1) * 12 + 12) + 'px', opacity: 0.55 } }, '读取中…'));
            } else if (!mem.length) {
              kids.push(h('div', { key: 'ne' + i, style: { paddingLeft: ((x.d + 1) * 12 + 12) + 'px', opacity: 0.55 } }, '（这条枝下还没有会话）'));
            } else {
              mem.slice(0, 200).forEach(function (m, k) {
                kids.push(h('div', {
                  key: 'm' + i + '_' + k,
                  draggable: true,
                  title: '拖动可把这条' + (m.kind === 'session' ? '会话' : '历史条目') + '挪到别的枝(Alt+拖 = 只连边)',
                  onDragStart: function (ev) {
                    setDragIds(['conv|' + m.source + '|' + m.convId]);
                    // 审计 C#4:记下来源枝 —— 会话条目 id 里没有"我属于哪条枝"这一段
                    refDragFrom.current = x.n.id;
                    try { ev.dataTransfer.setData('text/plain', m.convId); ev.dataTransfer.effectAllowed = 'move'; } catch (e) { /* noop */ }
                  },
                  onDragEnd: function () { refDragFrom.current = ''; },
                  onDragOver: function (ev) {
                    ev.preventDefault();
                    var cid = 'conv|' + m.source + '|' + m.convId;
                    if (dropTarget !== cid) setDropTarget(cid);
                    try { ev.dataTransfer.dropEffect = ev.altKey ? 'link' : 'move'; } catch (e) { /* noop */ }
                  },
                  onDragLeave: function () { setDropTarget(''); },
                  onDrop: function (ev) {
                    ev.preventDefault();
                    setDropTarget('');
                    if (!unlocked) { toast('🔒 先点「🔒 进入复盘模式」再拖动'); return; }
                    // 审计 C#5:会话行当落点时,**目标解析为它所属的那条枝** —— 会话自己不是
                    // 可挂载的容器。直接把 conv|<source>|<convId> 当 targetId 传下去,后端要么
                    // 报错、要么落成"自己移到自己",而 toast 照样报成功(主人以为移动了)。
                    var dropped = dragIds.filter(function (z) { return z !== 'conv|' + m.source + '|' + m.convId; });
                    if (!dropped.length) { toast('这是同一条会话 —— 要挪位置请拖到别的枝上'); return; }
                    sideDrop(dropped, x.n.id, ev.altKey, refDragFrom.current || x.n.id);
                  },
                  // id 形态必须与拖动一致(conv|<source>|<convId>) —— 少了 source 段就选不中
                  onClick: function () { setDragIds(['conv|' + m.source + '|' + m.convId]); },
                  style: (function () {
                    var cid = 'conv|' + m.source + '|' + m.convId;
                    var con = dragIds.indexOf(cid) >= 0;
                    return {
                      paddingLeft: ((x.d + 1) * 12 + 12) + 'px', fontSize: '11px', opacity: 0.85,
                      cursor: 'grab', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      userSelect: 'none', WebkitUserSelect: 'none', borderRadius: '5px',
                      // 会话级也要有选中可视化(2026-09-22 用户:会话能拖但看不出选没选中)
                      background: con ? 'rgba(197,139,47,.22)' : 'transparent',
                      outline: (dropTarget === cid) ? '2px dashed #3fb9a6'
                        : (con ? '1px solid rgba(197,139,47,.5)' : 'none'),
                      outlineOffset: '-2px',
                    };
                  })(),
                }, '· ' + (m.title ? String(m.title).slice(0, 34) : ('#' + String(m.convId).slice(-8)))));
              });
              if (mem.length > 200) {
                kids.push(h('div', { key: 'mm' + i, style: { paddingLeft: ((x.d + 1) * 12 + 12) + 'px', opacity: 0.5 } },
                  '…共 ' + mem.length + ' 条'));
              }
            }
          }
        });
        // ---- 选中节点的编辑区(原名/并脉/权重/连边,原记忆中心「记忆树·复盘」的操作区) ----
        var selX = null;
        for (var qi = 0; qi < flat.length; qi++) { if (flat[qi].n.id === selId) { selX = flat[qi].n; break; } }
        // TREE_KIND 原本是记忆中心面板函数内的局部变量(:1982),本组件作用域取不到,
        // 直接引用会 ReferenceError;这里是同值副本(2026-09-22)。
        var TREE_KIND = { trunk: '主干', branch: '枝', vein: '主脉' };
        // 快照时间:后端 at 存的是 UTC(utcIso),显示给主人必须转本地,
        // 否则会与名字里的本地时间(手动快照 - MM-DD HH:mm)差 8 小时。
        var fmtStamp = function (iso) {
          if (!iso) return '';
          var d = new Date(iso);
          if (isNaN(d.getTime())) return String(iso).slice(5, 16).replace('T', ' ');
          var p = function (n) { return (n < 10 ? '0' : '') + n; };
          return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
        };
        var inCss = {
          width: '100%', boxSizing: 'border-box', background: '#12161f', color: '#e6e9ef',
          border: '1px solid var(--lg-border,#333)', borderRadius: '6px',
          padding: '3px 6px', fontSize: '12px', marginBottom: '4px',
        };
        kids.push(h('div', { key: 'oh', style: { fontWeight: 700, margin: '10px 0 2px' } },
          selX ? ('已选 [' + (TREE_KIND[selX.kind] || selX.kind) + '] ' + (selX.name || selX.id)) : '编辑 · 点上面一条枝 / 主脉'));
        // 连边清单:移到编辑区显示(原在树里,点选不同节点时会不断累加、撑乱行高)
        if (selX) {
          var selLinks = [];
          allLinks.forEach(function (l) {
            var la = linkA(l), lb = linkB(l);
            if (la === selX.id) selLinks.push({ out: true, other: lb, kind: l.kind });
            else if (lb === selX.id) selLinks.push({ out: false, other: la, kind: l.kind });
          });
          if (selLinks.length) {
            kids.push(h('div', { key: 'sl', style: { margin: '2px 0 6px' } },
              [h('div', { key: 'st', style: { opacity: 0.7, fontSize: '11px' } }, '连边 ' + selLinks.length + ' 条')]
                .concat(selLinks.slice(0, 12).map(function (z, zi) {
                  return h('div', {
                    key: 'sl' + zi,
                    style: { color: '#c58b2f', fontSize: '11px', opacity: 0.92, paddingLeft: '8px' },
                  }, (z.out ? '→ ' : '← ') + nameOf(z.other) + '  (' + String(z.kind || 'related') + ')');
                }))));
          }
        }
        if (!selX) {
          kids.push(h('div', { key: 'o0', style: { opacity: 0.65 } }, '选中后在这里改名 / 并脉 / 连边 / 调权重。'));
        } else if (!unlocked) {
          kids.push(h('div', { key: 'o1', style: { opacity: 0.65 } }, '🔒 先点下面「🔒 进入复盘模式」才能修改。'));
        } else {
          var targetOpts = flat.filter(function (y) { return y.n.id !== selX.id; });
          kids.push(h('div', { key: 'rn' }, [
            h('div', { key: 'l', style: { opacity: 0.7 } }, '名字'),
            h('input', { key: 'i' + selX.id, ref: refName, defaultValue: selX.name || '', style: inCss }),
            h('button', {
              key: 'b', type: 'button',
              onClick: function () {
                var v = String((refName.current && refName.current.value) || '').trim();
                if (!v) { toast('名字不能为空'); return; }
                api('/branches/rename', { method: 'POST', body: { id: selX.id, name: v, lock: true } })
                  .then(function (r) { toast(r && r.ok ? '已改名并上锁' : ('✗ ' + ((r && r.reason) || '改名失败'))); sideReload(); })
                  .catch(function (e) { toast('✗ 改名失败:' + ((e && e.message) || '')); });
              },
            }, '改名'),
          ]));
          kids.push(h('div', { key: 'rp' }, [
            h('div', { key: 'l', style: { opacity: 0.7 } }, '并脉(挂到哪条枝 / 主脉下)'),
            h('select', { key: 's', ref: refRep, defaultValue: selX.parentId || 'trunk', style: inCss },
              flat.map(function (y) {
                return h('option', { key: y.n.id, value: y.n.id }, '[' + (TREE_KIND[y.n.kind] || y.n.kind) + '] ' + (y.n.name || y.n.id));
              })),
            h('input', { key: 'n', ref: refRepNew, placeholder: '或新建主脉名(可留空)', style: inCss }),
            h('button', {
              key: 'b', type: 'button',
              onClick: function () {
                var t = String((refRep.current && refRep.current.value) || 'trunk');
                var nn = String((refRepNew.current && refRepNew.current.value) || '').trim();
                api('/branches/reparent', { method: 'POST', body: { id: selX.id, parentId: t, name: nn || undefined } })
                  .then(function (r) { toast(r && r.ok ? (nn ? ('已建主脉「' + nn + '」并挂上去') : '已并脉(内容零变化)') : ('✗ ' + ((r && r.reason) || '并脉失败'))); sideReload(); })
                  .catch(function (e) { toast('✗ 并脉失败:' + ((e && e.message) || '')); });
              },
            }, '并到'),
          ]));
          kids.push(h('div', { key: 'wt' }, [
            h('div', { key: 'l', style: { opacity: 0.7 } }, '枝系数 0~2(复盘期调整,已留痕)'),
            h('input', { key: 'i' + selX.id, ref: refW, defaultValue: String(selX.weightScale == null ? 1 : selX.weightScale), style: inCss }),
            h('button', {
              key: 'b', type: 'button',
              onClick: function () {
                var v = Number((refW.current && refW.current.value) || 1);
                if (!isFinite(v)) { toast('系数必须是数字'); return; }
                api('/branches/weight', { method: 'POST', body: { id: selX.id, weightScale: v } })
                  .then(function (r) { toast(r && r.ok ? ('已设为 ×' + r.weightScale) : ('✗ ' + ((r && r.reason) || '调权重失败'))); sideReload(); })
                  .catch(function (e) { toast('✗ 调权重失败:' + ((e && e.message) || '')); });
              },
            }, '调权重'),
          ]));
          kids.push(h('div', { key: 'lk' }, [
            h('div', { key: 'l', style: { opacity: 0.7 } }, '连边(横向关联,不改归属)'),
            h('select', { key: 's', ref: refLk, defaultValue: '', style: inCss },
              [h('option', { key: '_', value: '' }, '（选择要连的枝）')].concat(targetOpts.map(function (y) {
                return h('option', { key: y.n.id, value: y.n.id }, '[' + (TREE_KIND[y.n.kind] || y.n.kind) + '] ' + (y.n.name || y.n.id));
              }))),
            h('input', { key: 'n', ref: refLkNote, placeholder: '为什么连(可留空)', style: inCss }),
            h('button', {
              key: 'b', type: 'button',
              onClick: function () {
                var to = String((refLk.current && refLk.current.value) || '');
                if (!to) { toast('先选一条要连的枝'); return; }
                api('/veins/link', { method: 'POST', body: { from: selX.id, to: to, kind: 'related', note: String((refLkNote.current && refLkNote.current.value) || '') } })
                  .then(function (r) { toast(r && r.ok ? '已连边' : ('✗ ' + ((r && r.reason) || '连边失败'))); sideReload(); })
                  .catch(function (e) { toast('✗ 连边失败:' + ((e && e.message) || '')); });
              },
            }, '连边'),
          ]));
        }
        // ---- R7 主脉提炼(2026-09-23):提炼只提议、不自动写记忆 ----
        // 设计稿 §5:主脉的记忆来自「其子枝的概述」,由复盘时提炼 + 主人审核后才生效。
        var doDistill = function (veinId) {
          if (lingBusyNow()) { toast('有操作正在跑,等它结束再提炼'); return; }
          toast('正在提炼…(素材:该主脉及其子枝的概述)');
          api('/vein/distill', { method: 'POST', body: { veinId: veinId } })
            .then(function (r) {
              if (!r || !r.ok) {
                var hint = {
                  'no-material': '这条主脉下还没有带摘要的记忆 —— 先把枝并进来,或多聊几句让概述器生成摘要',
                  'not-a-vein': '只有主脉能提炼(普通枝请先并到主脉下)',
                  'vein-not-found': '这条主脉不存在',
                  'assistant-unavailable': '模型不可用 —— 到「接入历史」检查小助手配置',
                  'llm-failed': '模型调用失败',
                }[r && r.reason] || '提炼失败';
                toast('✗ ' + hint);
                return;
              }
              toast('已产出候选 —— 到下面「主脉提炼」审核(采纳后才成为主脉记忆)');
              sideReload();
            })
            .catch(function (e) { toast('✗ 提炼失败:' + ((e && e.message) || '未知')); });
        };
        var resolveSug = function (id, action, text) {
          // 用户 2026-09-25 裁决(乙):**提炼不锁、采纳要解锁**。
          //   「提炼」只往候选表写一行草稿,不碰记忆 ⇒ 不锁(锁它会抬启动成本);
          //   「采纳」会写 conv_overview(source='vein') + assignConv 改树归属 ⇒ 与改名/并脉同级,故要走同一道门。
          //   「驳回」不写任何东西 ⇒ 不锁。
          if (action === 'accept' && !unlocked) {
            toast('🔒 采纳会写入主脉记忆并改树归属 —— 先点「🔒 进入复盘模式」再采纳');
            return;
          }
          api('/vein/suggestion/resolve', { method: 'POST', body: { id: id, action: action, text: text } })
            .then(function (r) {
              if (!r || !r.ok) { toast('✗ ' + ((r && r.reason) || '操作失败')); return; }
              toast(action === 'accept' ? '已采纳 —— 成为主脉自己的记忆(带派生来源)' : '已驳回');
              sideReload();
            })
            .catch(function (e) { toast('✗ 操作失败:' + ((e && e.message) || '')); });
        };
        if (selX && selX.kind === 'vein') {
          kids.push(h('div', { key: 'ds', style: { marginTop: '8px' } }, [
            h('div', { key: 'l', style: { opacity: 0.7 } },
              '✦ 主脉提炼 —— 从这条主脉及其子枝的概述里提炼共性;只提议,不自动写记忆。'),
            h('button', { key: 'b', type: 'button', onClick: function () { doDistill(selX.id); } }, '✦ 提炼主脉'),
          ]));
        } else if (selX && selX.kind === 'branch') {
          // B(2026-09-25 用户):枝上也要有提炼入口 —— 但提炼的素材是"主脉及其子枝",
          // 对枝本身提炼没有意义。所以这里先沿 parentId 往上找它所属的主脉,
          // 按钮直接对**那条主脉**做提炼,并在文案里说清对象,省掉"自己去列表里找主脉"这一跳。
          var vAnc = null;
          for (var vNode = selX, vHop = 0; vNode && vHop < 20; vHop += 1) {
            if (vNode.kind === 'vein') { vAnc = vNode; break; }
            if (!vNode.parentId || vNode.parentId === 'trunk') break;
            var vNext = null;
            for (var vi2 = 0; vi2 < flat.length; vi2 += 1) {
              if (flat[vi2].n.id === vNode.parentId) { vNext = flat[vi2].n; break; }
            }
            vNode = vNext;
          }
          kids.push(h('div', { key: 'dsb', style: { marginTop: '8px' } }, vAnc
            ? [
              h('div', { key: 'l', style: { opacity: 0.7 } },
                '✦ 提炼 —— 这条是枝;提炼对包含它的主脉「' + (vAnc.name || vAnc.id) + '」做。'),
              h('button', {
                key: 'b', type: 'button',
                onClick: function () { doDistill(vAnc.id); },
              }, '提炼'),
            ]
            : [h('div', { key: 'l', style: { opacity: 0.7 } },
              '✦ 提炼 —— 这条枝还没挂在主脉下;先并脉(挂到某条主脉),再对它提炼。')]));
        }
        // ---- R7 主脉提炼审核队列(2026-09-23) ----
        // 2026-09-25 用户:「提炼结果放在『主脉提炼』那一条底下」—— 审核队列紧跟提炼入口,
        // 点完提炼往下看就是候选,不必滚到页面别处去找。
        // 设计稿 §5:提炼结果先入队、带派生来源;采纳后才写进主脉记忆,且可"改后采纳"(文本框里改完再点采纳)。
        if (veinSugs.length) {
          kids.push(h('div', { key: 'vsh', style: { fontWeight: 700, margin: '10px 0 2px' } },
            '✦ 主脉提炼 · 待审核 ' + veinSugs.length + ' 条'));
          kids.push(h('div', { key: 'vsn', style: { opacity: 0.7, fontSize: '11px', marginBottom: '4px' } },
            '器灵从子枝的概述里提炼出的共性;采纳后才成为那条主脉自己的记忆'
            + '(可在框里改后采纳;提炼不锁,采纳需先「🔒 进入复盘模式」)。'));
          var taRefs = {};
          veinSugs.slice(0, 6).forEach(function (sg, i) {
            kids.push(h('div', {
              key: 'vs' + i,
              style: { border: '1px solid var(--lg-border)', borderRadius: '7px', padding: '6px 8px', marginBottom: '6px' },
            }, [
              h('div', { key: 'm', style: { opacity: 0.7, fontSize: '11px', marginBottom: '2px' } },
                '→ ' + nameOf(sg.veinId) + '  ·  来源 ' + ((sg.sources && sg.sources.length) || 0) + ' 条'
                + (sg.model ? ('  ·  ' + String(sg.model).slice(0, 24)) : '')),
              h('textarea', {
                key: 'ta', rows: 3, defaultValue: sg.text || '',
                ref: function (el) { if (el) taRefs[sg.id] = el; },
                style: {
                  width: '100%', boxSizing: 'border-box', background: '#12161f', color: '#e6e9ef',
                  border: '1px solid var(--lg-border,#333)', borderRadius: '6px',
                  padding: '4px 6px', fontSize: '12px', resize: 'vertical', marginBottom: '4px',
                },
              }),
              h('div', { key: 'b', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, [
                h('button', {
                  key: 'a', type: 'button',
                  title: unlocked ? '写入主脉自己的记忆(带派生来源)' : '需先「🔒 进入复盘模式」解锁',
                  style: unlocked ? {} : { opacity: 0.5 },
                  onClick: function () {
                    var el = taRefs[sg.id];
                    resolveSug(sg.id, 'accept', el ? String(el.value || '') : (sg.text || ''));
                  },
                }, unlocked ? '✓ 采纳' : '🔒 采纳'),
                h('button', {
                  key: 'r', type: 'button',
                  onClick: function () { resolveSug(sg.id, 'reject', ''); },
                }, '✗ 驳回'),
              ]),
            ]));
          });
        }
        kids.push(h('div', { key: 'vn', style: { marginTop: '8px' } }, [
          h('div', { key: 'l', style: { opacity: 0.7 } }, '＋ 建主脉(把几条枝归到一起的抽象节点)'),
          h('input', { key: 'i', ref: refVein, placeholder: '主脉名,例如:力学 / 网络架构', style: inCss }),
          h('button', {
            key: 'b', type: 'button',
            onClick: function () {
              var v = String((refVein.current && refVein.current.value) || '').trim();
              if (!v) { toast('请填主脉名'); return; }
              api('/branches/create', { method: 'POST', body: { kind: 'vein', name: v } })
                .then(function (r) { toast(r && r.ok ? ('已建主脉「' + v + '」') : ('✗ ' + ((r && r.reason) || '建主脉失败'))); sideReload(); })
                .catch(function (e) { toast('✗ 建主脉失败:' + ((e && e.message) || '')); });
            },
          }, '＋ 建主脉'),
        ]));
        // 审计 C#14:被截掉的是 `flat.length - SIDE_TREE_MAX` 个(不是 `flat.length - 40`)。
        if (flat.length > SIDE_TREE_MAX) {
          kids.push(h('div', { key: 'more', style: { opacity: 0.6 } },
            '…共 ' + flat.length + ' 个节点,这里只画了前 ' + SIDE_TREE_MAX + ' 个(还有 '
            + (flat.length - SIDE_TREE_MAX) + ' 个未显示)'));
        }
        kids.push(h('div', { key: 'ch', style: { fontWeight: 700, margin: '9px 0 2px' } },
          '待复盘矛盾 · ' + pend.length));
        if (!pend.length) kids.push(h('div', { key: 'cn', style: { opacity: 0.6 } }, '（暂无,去记忆中心扫一次）'));
        pend.slice(0, 6).forEach(function (c, i) {
          kids.push(h('div', { key: 'c' + i, style: { opacity: 0.85 } },
            '· [' + c.kind + '] ' + String(c.aTitle || '?').slice(0, 16) + ' ⟷ ' + String(c.bTitle || '?').slice(0, 16)));
        });
        // (审核队列已上移到「✦ 提炼」入口正下方 —— 见前面 `veinSugs.length` 那段)
        kids.push(h('div', { key: 'oph', style: { fontWeight: 700, margin: '10px 0 2px' } }, '复盘操作'));
        kids.push(h('div', { key: 'ops', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          h('button', {
            key: 's',
            type: 'button',
            title: '启发式扫描:只找"措辞高度重复"的记忆对(2-gram Jaccard ≥ 阈值),零模型调用。它不理解语义,只产候选 —— 性质由「✦ 模型判定」定。',
            onClick: function () {
              if (lingBusyNow()) { toast('正在跑,稍等…'); return; }
              lingBusy = true; lingBusyUntil = Date.now() + LING_BUSY_MS;
              // 审计 C#9:原来只在 .then 里复位 —— 既不 resolve 也不 reject 时永久 busy。
              // 这里用 .then(…).catch(…)**两路**复位(lingOps 内部已各自 toast,故 catch 只复位)。
              lingOps.scan().then(function () { lingBusy = false; sideReload(); },
                function (e) { lingBusy = false; console.warn('[dsh-ling] 扫描异常', e); sideReload(); });
            },
          }, '🕵 扫疑似重复'),
          h('button', {
            key: 'j',
            type: 'button',
            title: '让模型读两侧摘要全文,判断「重复」「矛盾」还是「无关」:判为无关的自动驳回,判不准的一律不动,留给人工裁定。需要小助手可用。',
            onClick: function () {
              if (lingBusyNow()) { toast('正在跑,稍等…'); return; }
              lingBusy = true; lingBusyUntil = Date.now() + LING_BUSY_MS;
              lingOps.judge().then(function () { lingBusy = false; sideReload(); },
                function (e) { lingBusy = false; console.warn('[dsh-ling] 模型判定异常', e); sideReload(); });
            },
          }, '✦ 模型判定'),
          h('button', {
            key: 'g',
            type: 'button',
            title: '把名字含「零散」的枝统一收进主脉「零散会话」下(幂等,可重复跑)。',
            onClick: function () {
              if (lingBusyNow()) { toast('正在跑,稍等…'); return; }
              lingBusy = true; lingBusyUntil = Date.now() + LING_BUSY_MS;
              lingOps.gather().then(function () { lingBusy = false; sideReload(); },
                function (e) { lingBusy = false; console.warn('[dsh-ling] 归并异常', e); sideReload(); });
            },
          }, '🧹 归并零散枝')));
        // ---- R1 树的保存 / 恢复:大改之前存一份,随时能回来 ----
        //    快照只存**结构**(枝/归属/连边),不存记忆内容;恢复前服务端会**自动再备份一次**,
        //    所以"恢复"这个动作本身也是可撤的 —— 故这里不弹二次确认,保持门槛低。
        kids.push(h('div', { key: 'sh', style: { fontWeight: 700, margin: '10px 0 2px' } }, '树的保存 / 恢复'));
        kids.push(h('div', { key: 'sv', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, [
          h('input', {
            key: 'i', ref: refSnap, placeholder: '快照名,例如:大改之前',
            style: Object.assign({}, sIn, { flex: '1', minWidth: '110px' }),
          }),
          h('button', {
            key: 'b', type: 'button',
            title: '把当前树结构存成一份快照(只存结构,不存记忆内容)',
            onClick: function () {
              var nm = String((refSnap.current && refSnap.current.value) || '').trim();
              api('/tree/snapshot', { method: 'POST', body: { name: nm } }).then(function (r) {
                if (r && r.ok) {
                  if (refSnap.current) refSnap.current.value = '';
                  toast('已保存快照 #' + r.id);
                } else { toast('✗ ' + ((r && r.reason) || '保存失败')); }
                sideReload();
              }).catch(function (e) { toast('✗ 保存失败:' + ((e && e.message) || '')); });
            },
          }, '💾 保存快照'),
        ]));
        if (!snapshots.length) {
          kids.push(h('div', { key: 'sn0', style: { opacity: 0.6 } }, '（还没有快照 —— 大改之前先存一份,随时能回来）'));
        } else {
          snapshots.slice(0, 8).forEach(function (s, i) {
            kids.push(h('div', { key: 'sn' + i, style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '3px' } }, [
              h('span', {
                key: 't',
                style: { flex: '1', opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              }, '#' + s.id + ' ' + (s.name || fmtStamp(s.at))),
              h('button', {
                key: 'r', type: 'button',
                title: '恢复到这份快照(恢复前会自动把当前状态存成一份新快照,可再撤回来)',
                onClick: function () { restoreSnapshot(s); },
              }, '恢复'),
              h('button', {
                key: 'd', type: 'button', title: '删除这份快照',
                onClick: function () { delSnapshot(s.id); },
              }, '删'),
            ]));
          });
        }
        // ---- 最近改动 ----
        // 2026-09-25 用户:「『最近改动』块挪到『树的保存/恢复』底下」—— 它记的是"谁在什么时候
        // 动了树",与上面那排快照是同一件事的两面(一份是存档,一份是流水),放一起才顺。
        if (data.log.length) {
          kids.push(h('div', { key: 'lh', style: { fontWeight: 700, margin: '9px 0 2px' } }, '最近改动'));
          data.log.slice(0, 6).forEach(function (l, i) {
            kids.push(h('div', { key: 'l' + i, style: { opacity: 0.7 } },
              '· ' + String(l.at || '').slice(5, 16).replace('T', ' ') + '  '
              + (l.branchName || l.branchId) + '  ' + l.action));
          });
        }
        if (pendingChanges > 0) {
          kids.push(h('div', {
            key: 'pd',
            style: {
              marginTop: '8px', padding: '6px 8px', borderRadius: '8px',
              border: '1px solid rgba(197,139,47,.45)', color: '#e8c07a',
              background: 'rgba(197,139,47,.10)',
            },
          }, '⚠ 有 ' + pendingChanges + ' 笔改动还没跟器灵说过 —— 在左边说一句话,它就能看到(这也就是复盘的开始与结束)。'));
        }
        kids.push(h('div', { key: 'bt', style: { marginTop: '10px', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          h('button', {
            key: 'u',
            type: 'button',
            title: unlocked
              ? '退出复盘模式:树恢复只读'
              : '进入复盘模式:解锁编辑 + 复制复盘开场白(与总控板「一键进入复盘」一致)',
            style: unlocked ? { borderColor: '#c58b2f', color: '#c58b2f' } : {},
            onClick: function () {
              var next = !unlocked;
              // 复盘守门(2026-09-22 用户:「互相复盘不应该被我绕过」):退出前必须先把
              // 未同步的改动交代给器灵 —— 不能"改完几十处直接走人",那等于假复盘。
              // 2026-09-23 修:显示值可能滞后(器灵开口才推进水位,而"发言"不触发本面板重载),
              // 所以退出前**实时查一次**服务端 —— 避免"明明已经同步了却拦着不让退"。
              if (!next) {
                api('/branch-log/pending').then(function (r) {
                  var p = (r && r.ok) ? Number(r.pending || 0) : pendingChanges;
                  setPendingChanges(p);
                  if (p > 0) {
                    toast('还有 ' + p + ' 笔改动没说给器灵 —— 在左边说一句话让它看到,再退出复盘模式。');
                    return;
                  }
                  setUnlocked(false);
                  setLingUnlocked(false, true);
                }).catch(function () {
                  if (pendingChanges > 0) {
                    toast('还有 ' + pendingChanges + ' 笔改动没说给器灵 —— 在左边说一句话让它看到,再退出复盘模式。');
                    return;
                  }
                  setUnlocked(false);
                  setLingUnlocked(false, true);
                });
                return;
              }
              setUnlocked(next);
              setLingUnlocked(next, true);
              // 进入复盘模式 = 解锁 + 备好开场白(2026-09-22 用户:行为与总控板「一键进入复盘」对齐)
              // 审计 C#17:原来这里把 reviewCopy 当同步函数 —— 它返回 Promise,所以 try/catch
              // 根本抓不到复制失败,而且**不等结果**就先报「已复制」。改成等结果再说文案。
              if (next) {
                var copyText = '';
                try { copyText = reviewPromptOf(data.tree, data.conflicts); }
                catch (e) { console.warn('[dsh-ling] 生成复盘开场白失败', e); }
                if (!copyText) { toast('已进入复盘模式(暂无开场材料)'); return; }
                reviewCopy(copyText, true).then(function (okCopy) {
                  toast(okCopy
                    ? '已进入复盘模式 —— 复盘开场白已复制,开新会话粘进去即可'
                    : '已进入复盘模式,但浏览器拒绝了自动复制 —— 请到「复盘材料」里手动复制');
                }).catch(function (e) {
                  console.warn('[dsh-ling] 复制复盘开场白失败', e);
                  toast('已进入复盘模式 —— 复制失败(' + ((e && e.message) || '未知') + '),请手动复制');
                });
              }
            },
          }, unlocked ? '🔓 退出复盘模式' : '🔒 进入复盘模式'),
          h('button', {
            key: 'r',
            type: 'button',
            onClick: function () { sideReload(); },
          }, '刷新'),
          h('button', {
            key: 'z',
            type: 'button',
            title: '撤回上一次拖动(Ctrl+Z 同效)',
            onClick: function () { sideUndo(); },
          }, '↶ 撤回')));
        // Ctrl+Z / Cmd+Z 撤回一步:监听挂在本面板容器上(随面板销毁自动回收,不挂 document)
        return h('div', {
          style: box,
          ref: boxRef,
          onScroll: function (ev) { sScroll.current = ev.currentTarget.scrollTop; },
          tabIndex: 0,
          onKeyDown: function (ev) {
            if ((ev.ctrlKey || ev.metaKey) && String(ev.key || '').toLowerCase() === 'z') {
              ev.preventDefault();
              sideUndo();
            }
          },
        }, kids);
      }

      /** 打开右侧栏的复盘面板(记忆中心按钮调用)。 */
      function openReviewSidebar() {
        try {
          // 用 ctx.get() 取服务,不要属性访问 —— cordis 的 ctx.sidebarRight 在未 inject 时
          // 会抛 'cannot get property "sidebarRight" without inject';ctx.get() 只返回 undefined。
          var svc = null;
          try { svc = (lingCtx && typeof lingCtx.get === 'function') ? lingCtx.get('sidebarRight') : null; } catch (e) { svc = null; }
          if (!svc || typeof svc.openTab !== 'function') {
            toast('右侧栏不可用 —— 请手动打开右栏(刚改过代码的话需重启 dsh web)');
            return false;
          }
          var active = null;
          try { active = svc.active(); } catch (e) { active = null; }
          svc.openTab(LING_REVIEW_KIND, active ? { replaceTab: active.id } : {});
          return true;
        } catch (e) {
          toast('打开侧栏失败:' + ((e && e.message) || '未知'));
          return false;
        }
      }

      /**
       * 复盘操作总线(2026-09-22):记忆中心已改为**只读视图**,复盘操作(扫重复/模型判定/归并零散枝)
       * 集中在右侧复盘栏。两个面板作用域不同(记忆中心是 DOM 闭包、侧栏是 React 组件),
       * 故把操作放模块级共用;每个操作返回 Promise,调用方自己决定何时刷新。
       */
      var lingBusy = false; // 复盘操作防重入(扫重复/模型判定可能跑几十秒)
      /**
       * 审计 C#9:给 lingBusy 加**时间兜底**。旧实现只在 `.then` 里复位,
       * 一旦操作既不 resolve 也不 reject(网关挂住 / fetch 永不返回),这三个按钮就**永久卡死**
       * 在「正在跑,稍等…」。用 deadline 兜底:超过上限后允许再次点,并顺手复位。
       * 记 deadline 而不是"启动定时器":面板可能已被销毁,setTimeout 反而会泄漏。
       */
      var LING_BUSY_MS = 180000; // 3 分钟:judge 每轮 5 条、最多 40 轮,单轮几十秒时的宽松上限
      var lingBusyUntil = 0;
      function lingBusyNow() {
        if (lingBusy && Date.now() < lingBusyUntil) return true;
        if (lingBusy) { // 超时兜底:放行 + 复位,并留一条 warn 便于定位
          lingBusy = false;
          console.warn('[dsh-ling] 复盘操作超时未返回,已自动解除忙碌锁');
        }
        return false;
      }
      var lingOps = {
        scan: function () {
          return api('/conflicts/scan', { method: 'POST', body: { limit: 80, threshold: 0.55 } })
            .then(function (r) {
              if (!r || !r.ok) { toast('✗ ' + ((r && r.reason) || '扫描失败')); return null; }
              // 审计 C#1:端点返回 `{scanned, threshold, found, pairs}` —— `found` 是**计数**、
              // `pairs` 是**数组**、`recorded` 字段根本不存在 ⇒ 旧写法非空时算成 NaN、恰好 0 条时蒙对。
              toast('扫到 ' + Number(r.found || 0) + ' 对候选 —— 再用「✦ 模型判定」定性质');
              return r;
            })
            .catch(function (e) {
              // 审计 C#16:catch 必须报真实原因,不能统一吞成「(网关)」—— 用户看不出是断网、
              // 超时、还是后端 500,也无法据此决定要不要重试。
              console.warn('[dsh-ling] 扫描失败', e);
              toast('✗ 扫描失败:' + ((e && e.message) || '未知'));
              return null;
            });
        },
        judge: function (onProgress) {
          var total = 0;
          var rounds = 0;
          var lastLeft = Infinity;
          var MAX_ROUNDS = 40;   // 5 条/轮 × 40 = 200 条,足够;审计 C#2:此前 step() 无上限递归
          var step = function () {
            rounds += 1;
            return api('/conflicts/judge', { method: 'POST', body: { limit: 5 } }).then(function (r) {
              if (!r || !r.ok) { toast('✗ ' + ((r && r.reason) || '模型判定失败')); return null; }
              var judged = Number(r.judged || 0);
              var left = Number(r.left || 0);
              total += judged;
              if (typeof onProgress === 'function') onProgress(total, left);
              if (!left) return r;
              // 两条刹车(审计 C#2):后端可能每轮返回同样的 left 而 judged=0(全是 unknown),
              // 旧写法 `if (r.left) return step()` 会**无限递归** —— 每轮都真烧一次模型调用。
              if (!judged || left >= lastLeft) { toast('模型判定停在 ' + left + ' 条未决(判不准的留给人工)'); return r; }
              lastLeft = left;
              if (rounds >= MAX_ROUNDS) { toast('模型判定到轮数上限(' + MAX_ROUNDS + ' 轮),剩 ' + left + ' 条留人工'); return r; }
              return step();
            });
          };
          return step().then(function (r) {
            if (!r) return null;
            toast('模型判定完成:判了 ' + total + ' 条(判为「无关」的已自动驳回)');
            return r;
          }).catch(function (e) {
            // 审计 C#16:同上 —— 如实显示中断原因(区分网关断开 / 判定超时 / 后端报错)
            console.warn('[dsh-ling] 模型判定中断', e);
            toast('✗ 模型判定中断:' + ((e && e.message) || '未知'));
            return null;
          });
        },
        gather: function () {
          return api('/branches/gather', { method: 'POST', body: { pattern: '零散', veinName: '零散会话' } })
            .then(function (r) {
              if (!r || !r.ok) { toast('✗ ' + ((r && r.reason) || '归并失败')); return null; }
              toast(r.note || ('已归并 ' + r.moved + ' 条'));
              return r;
            })
            .catch(function (e) {
              // 审计 C#16:如实显示原因
              console.warn('[dsh-ling] 归并零散枝失败', e);
              toast('✗ 归并失败:' + ((e && e.message) || '未知'));
              return null;
            });
        },
      };

      /**
       * 一键进入复盘(总控板 + 记忆中心共用,2026-09-22):
       * 复制复盘开场白 + 解锁树编辑 + 打开右侧复盘栏 —— 一步把"左会话 + 右侧栏"那个状态摆好。
       * 注:客户端拿不到 sessions 服务,无法编程式开新会话,故"开新会话"仍是主人一步。
       */
      function startReviewFromMenu() {
        toast('正在准备复盘材料…');
        Promise.all([
          api('/tree').catch(function () { return null; }),
          api('/conflicts').catch(function () { return null; }),
        ]).then(function (rs) {
          var td = (rs[0] && rs[0].ok) ? rs[0] : { roots: [], links: [], total: 0 };
          var conf = (rs[1] && rs[1].ok) ? (rs[1].conflicts || []) : [];
          // ① 同步给记忆中心(经钩子 —— st 是本面板外的局部变量,直接写会 ReferenceError)
          try { if (lingCenterSync) lingCenterSync(td, conf); } catch (e) {
            // 审计 C#17:钩子体内一个拼错的变量名(ReferenceError)原来会被静默吞掉,
            // 用户只看到"记忆中心的树没跟着刷新"。打到 console 才能定位。
            console.warn('[dsh-ling] 同步记忆中心失败', e);
          }
          // ② 先生成材料(纯计算,失败不影响其他两步)
          var text = '';
          try { text = reviewPromptOf(td, conf); } catch (e) { text = ''; }
          // ③ 打开右侧复盘栏(自带 catch,失败只提示不抛)
          var opened = false;
          try { opened = openReviewSidebar(); } catch (e) { opened = false; }
          // ④ 解锁树编辑
          try { setLingUnlocked(true, true); } catch (e) { console.warn('[dsh-ling] 解锁树编辑失败', e); }
          // ⑤ 复制放最后(clipboard 是异步的,不吃用户手势同步性)
          //    审计 C#13:必须**等复制结果**再报文案 —— 旧实现两个分支都以「已复制」开头,
          //    而浏览器完全可能拒绝 clipboard(非用户手势 / 无权限),等于对用户撒谎。
          if (text) {
            reviewCopy(text, true).then(function (okCopy) {
              toast(okCopy
                ? (opened
                  ? '已复制复盘开场白 —— 开一个新会话粘进去,右边就是复盘栏'
                  : '已复制复盘开场白 —— 右侧栏未开,可手动打开后点「器灵 · 复盘」')
                : '复盘开场白已生成,但浏览器拒绝了自动复制 —— 到右侧栏点「🌱 复制复盘材料」再试');
            }).catch(function (e) {
              // 审计 C#17:reviewCopy 理论上自己会回退,但万一 Promise 本身被拒(如 clipboard 抛异常),
              // 不加这层会变成 unhandled rejection,用户那边则是"点了没反应"。
              console.warn('[dsh-ling] 复制复盘开场白失败', e);
              toast('复盘开场白已生成,但复制失败(' + ((e && e.message) || '未知') + ')—— 请在右侧栏手动复制');
            });
          } else {
            toast(opened ? '已进入复盘模式(暂无开场材料)' : '右侧栏未开 —— 可手动打开后点「器灵 · 复盘」');
          }
        }).catch(function (e) {
          toast('准备复盘材料失败:' + ((e && e.message) || '未知'));
        });
      }

      // ---------------- apply ----------------
      exports.name = 'dsh-ling';
      exports.inject = ['slots', 'locale', 'connection'];
      exports.apply = function apply(ctx) {
        try {
          lingCtx = ctx; // 供"打开复盘侧栏"按钮使用
          var storeS = createStore({ kind: 'session', mode: null, running: false, sessionId: null });
          var storeG = createStore({ kind: 'global', mode: null, running: false, sessionId: null });
          if (typeof ctx.effect === 'function') {
            ctx.effect(function () {
              ensureStyle();
              var disposed = false;
              function seat(store, slotName, slotId, order) {
                if (disposed) return;
                var Component = mount(store);
                if (!Component) return;
                try {
                  ctx.slots.inject(slotName, function* () {
                    if (disposed) return;
                    yield ctx.slots.register({
                      name: slotName,
                      id: slotId, // list 槽位必须带唯一 id(契约实证)
                      order: order,
                      locale: NS,
                      inject: function () { return {}; },
                    }, Component);
                  });
                } catch (e) {
                  console.warn('[dsh-ling] seat failed', slotName, e);
                }
              }
              try {
                if (ctx.slots && typeof ctx.slots.inject === 'function') {
                  seat(storeS, 'conversation.session.header.utilities', 'dsh-ling-btn', 80);
                  seat(storeG, 'sidebar.footer.action', 'dsh-ling-default-btn', 60);
                } else {
                  console.warn('[dsh-ling] slots/react unavailable; buttons not mounted');
                }
              } catch (e) {
                console.warn('[dsh-ling] slot mount failed', e);
              }
              return function () {
                disposed = true;
                closeOverlays();
              };
            }, 'dsh-ling: controller');
          }
          // 右侧栏面板:器灵 · 复盘模式 —— 两阶段注册(类型 + 正文槽)。
          // 用 ctx.inject 等服务就绪后再注册:官方 seat 先 declare 槽、后 provide 服务,
          // 拿槽回调触发注册会永久失败(此类坑由 dsh-better-sidebar 的源码注释实证)。
          // 该服务在官方 sidebar-right 包中提供;缺失时静默跳过,不影响插件其余功能。
          try {
            if (typeof ctx.inject === 'function') {
              // ⚠️ 只等 sidebarRightTabs —— 不要把 sidebarRight 也写进来:
              //   它是 per-session 绑定的控制器,在该注入作用域里可能永不满足,
              //   回调就永远不执行 ⇒ 面板类型注册不上 ⇒ openTab 抛
              //   'sidebarRight: no tab type is registered as "ling-review"'(用户实测)。
              //   打开面板时用 lingCtx.get('sidebarRight') 动态取即可(那时必然已挂载)。
              // 🔴 根因(2026-09-21 定位):服务必须从**回调参数**上取(scoped),
              //    不能用闭包里的 ctx —— cordis 的属性访问在未 inject 时抛
              //    'cannot get property "sidebarRightTabs" without inject',
              //    被下面的 catch 吞掉 ⇒ 注册静默失败 ⇒ openTab 报
              //    'sidebarRight: no tab type is registered as "ling-review"'。
              //    写法参照 dsh-context:ctx.inject(['sidebarRightTabs'], (raw) => … raw.sidebarRightTabs)。
              ctx.inject(['sidebarRightTabs'], function (scoped) {
                try {
                  var reg = scoped && scoped.sidebarRightTabs;
                  if (!reg || typeof reg.register !== 'function') return;
                  var disposeTab = reg.register({
                    id: LING_REVIEW_ID,
                    kind: LING_REVIEW_KIND,
                    priority: 'extension',
                    title: function () { return '器灵 · 复盘模式'; },
                    guide: [{
                      order: 55,
                      title: function () { return '器灵 · 复盘模式'; },
                      description: function () { return '记忆树复盘视图:树结构 / 待复盘矛盾 / 最近改动'; },
                    }],
                  });
                  if (typeof ctx.effect === 'function' && typeof disposeTab === 'function') {
                    ctx.effect(function () { return disposeTab; }, 'dsh-ling: sidebar tab type');
                  }
                  var sctx = scoped || ctx;
                  if (sctx.slots && typeof sctx.slots.inject === 'function') {
                    sctx.slots.inject('sidebar.right.pane.tab', function* () {
                      yield sctx.slots.register({
                        name: 'sidebar.right.pane.tab',
                        key: LING_REVIEW_ID, // keyed 槽:必须 === definition.id(不是 kind)
                        locale: NS,
                        inject: function () { return {}; },
                      }, LingReviewBody);
                    });
                  }
                } catch (e) {
                  console.warn('[dsh-ling] sidebar tab register failed', e);
                }
              });
            }
          } catch (e) {
            console.warn('[dsh-ling] sidebar mount failed', e);
          }
        } catch (e) {
          console.warn('[dsh-ling] client apply failed', e);
        }
      };
      return module.exports;
    },
  });
})();
