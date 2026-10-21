// ============================================================
// 浏览器视图内置脚本资源与快照模板（纯常量，零运行时副作用）
// 为什么存在：BrowserView 的起始页、注入脚本与快照模板需要集中管理，避免散落各处且无副作用。
// 由 browser-view-manager 在 createView / 导航完成后注入
// ============================================================

/**
 * 起始页（快速拨号）HTML：月蚀品牌 + 搜索框 + 常用搜索引擎入口。
 * 以 data URL 加载（避免 about:blank 白屏），页面内 JS 使用普通字符串拼接
 * （模板字符串外层约束，避免反引号/占位符与宿主模板冲突）。
 */
export const WELCOME_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>月蚀起始页</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #0d0f18;
    --accent: #d6b276;
    --fg: #e8e9f0;
    --fg-muted: #8a90a8;
    --border: rgba(120, 130, 170, 0.22);
  }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background:
      radial-gradient(circle at 70% 15%, rgba(196, 98, 90, 0.10), transparent 42%),
      radial-gradient(circle at 20% 85%, rgba(214, 178, 118, 0.08), transparent 45%),
      var(--bg);
    color: var(--fg);
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
  }
  .wrap { width: min(680px, 92vw); display: flex; flex-direction: column; align-items: center; gap: 30px; }
  .brand { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .moon {
    width: 52px; height: 52px; border-radius: 50%;
    background: linear-gradient(135deg, #ecdab5, #c4a173);
    display: flex; align-items: center; justify-content: center;
    font-size: 22px; font-weight: 600; color: #12141d;
    box-shadow: 0 0 34px rgba(214, 178, 118, 0.35);
  }
  .brand h1 { font-size: 19px; font-weight: 500; letter-spacing: 0.42em; text-indent: 0.42em; }
  .brand .en { font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase; color: var(--fg-muted); }
  .search { width: 100%; position: relative; }
  .search input {
    width: 100%; height: 48px; padding: 0 52px 0 20px;
    border-radius: 14px; border: 1px solid var(--border);
    background: rgba(24, 27, 42, 0.75); color: var(--fg);
    font-size: 15px; outline: none; transition: border-color .2s, box-shadow .2s;
  }
  .search input::placeholder { color: #6b7188; }
  .search input:focus { border-color: rgba(214, 178, 118, 0.7); box-shadow: 0 0 0 3px rgba(214, 178, 118, 0.14); }
  .search button {
    position: absolute; right: 6px; top: 6px; bottom: 6px;
    padding: 0 15px; border: none; border-radius: 10px;
    background: linear-gradient(135deg, #e0bf85, #c9a164); color: #15151c;
    font-size: 13px; font-weight: 600; cursor: pointer; transition: opacity .2s;
  }
  .search button:hover { opacity: 0.9; }
  .engines { width: 100%; display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .engine {
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    padding: 14px 8px 12px; border-radius: 14px;
    border: 1px solid transparent; background: rgba(24, 27, 42, 0.55);
    cursor: pointer; transition: all .18s; user-select: none;
  }
  .engine:hover { background: rgba(30, 34, 52, 0.85); border-color: var(--border); transform: translateY(-1px); }
  .engine.active { border-color: rgba(214, 178, 118, 0.6); background: rgba(214, 178, 118, 0.08); }
  .engine .badge {
    width: 38px; height: 38px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 15px; font-weight: 700; color: #fff; text-transform: uppercase;
  }
  .engine .name { font-size: 12px; color: var(--fg-muted); }
  .hint { font-size: 11px; color: #5c6278; text-align: center; line-height: 1.7; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="brand">
      <div class="moon">月</div>
      <h1>月蚀</h1>
      <div class="en">LunarEclipse</div>
    </div>
    <div class="search">
      <input id="q" type="text" placeholder="输入关键词，选择搜索引擎开始搜索" autofocus />
      <button id="go">搜索</button>
    </div>
    <div class="engines" id="engines"></div>
    <div class="hint">输入 URL 也可直接访问网页 · AI 可帮你操作浏览器（高亮 + 轨迹特效）</div>
  </div>
<script>
(function () {
  var ENGINES = [
    { name: '百度', badge: '百', color: '#315efb', search: 'https://www.baidu.com/s?wd=', home: 'https://www.baidu.com' },
    { name: '必应', badge: '必', color: '#008373', search: 'https://cn.bing.com/search?q=', home: 'https://cn.bing.com' },
    { name: '谷歌', badge: 'G', color: '#4285f4', search: 'https://www.google.com/search?q=', home: 'https://www.google.com' },
    { name: '知乎', badge: '知', color: '#0084ff', search: 'https://www.zhihu.com/search?type=content&q=', home: 'https://www.zhihu.com' },
    { name: 'B站', badge: 'B', color: '#fb7299', search: 'https://search.bilibili.com/all?keyword=', home: 'https://www.bilibili.com' },
    { name: '微博', badge: '微', color: '#ff8200', search: 'https://s.weibo.com/weibo?q=', home: 'https://weibo.com' },
    { name: '搜狗', badge: '搜', color: '#ff7417', search: 'https://www.sogou.com/web?query=', home: 'https://www.sogou.com' },
    // Shodan：互联网设备搜索引擎，可搜索暴露在公网上的摄像头/路由器/服务器等设备
    { name: 'Shodan', badge: 'S', color: '#e04e46', search: 'https://www.shodan.io/search?query=', home: 'https://www.shodan.io' }
  ];
  var selected = 0;
  var input = document.getElementById('q');
  var grid = document.getElementById('engines');
  var nodes = [];
  ENGINES.forEach(function (eng, i) {
    var el = document.createElement('div');
    el.className = 'engine' + (i === 0 ? ' active' : '');
    el.innerHTML = '<div class="badge" style="background:' + eng.color + '">' + eng.badge + '</div><div class="name">' + eng.name + '</div>';
    el.addEventListener('click', function () {
      selected = i;
      nodes.forEach(function (n, j) { n.classList.toggle('active', j === i); });
      var kw = input.value.trim();
      if (kw) {
        window.location.href = ENGINES[i].search + encodeURIComponent(kw);
      } else {
        window.location.href = ENGINES[i].home;
      }
    });
    grid.appendChild(el);
    nodes.push(el);
  });
  function doSearch() {
    var kw = input.value.trim();
    if (kw) {
      window.location.href = ENGINES[selected].search + encodeURIComponent(kw);
    } else {
      input.focus();
    }
  }
  document.getElementById('go').addEventListener('click', doSearch);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') doSearch();
  });
})();
</script>
</body>
</html>`

/** 起始页 data URL（浏览器视图初始加载与地址栏展示归一化共用） */
export const HOME_PAGE_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(WELCOME_HTML)

/** 追踪特效脚本：高亮框 / 鼠标轨迹 / 动作标签 / 模拟点击输入（IIFE，幂等） */
export const TRACKER_SCRIPT = `
        (function () {
          if (window.__lunareclipseTrackerInstalled) return;
          window.__lunareclipseTrackerInstalled = true;

          // ============ 1. 元素高亮框（SVG 红色闪烁边框） ============
          const highlightLayer = document.createElement('div');
          highlightLayer.id = '__le_highlight_layer';
          highlightLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:999999;';
          document.body.appendChild(highlightLayer);

          window.__leHighlightElement = function(rect, durationMs) {
            durationMs = durationMs || 2000;
            const box = document.createElement('div');
            box.style.cssText = 'position:fixed;left:' + rect.x + 'px;top:' + rect.y + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px;border:3px solid #ff4444;border-radius:4px;box-shadow:0 0 20px #ff4444,0 0 8px #ff4444 inset;animation:__le_pulse 0.6s ease-in-out infinite;pointer-events:none;z-index:1000000;';
            highlightLayer.appendChild(box);
            setTimeout(() => box.remove(), durationMs);
          };

          // 闪烁动画
          const style = document.createElement('style');
          style.textContent = '@keyframes __le_pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(1.03)}}';
          document.head.appendChild(style);

          // ============ 2. 鼠标轨迹动画（虚拟指针） ============
          const cursor = document.createElement('div');
          cursor.id = '__le_virtual_cursor';
          cursor.style.cssText = 'position:fixed;left:0;top:0;width:24px;height:24px;pointer-events:none;z-index:1000001;transition:transform 0.5s cubic-bezier(0.4,0,0.2,1);opacity:0;';
          cursor.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M5 3l14 9-6 1-3 7-5-17z" fill="#ff4444" stroke="white" stroke-width="1.5"/></svg>';
          document.body.appendChild(cursor);

          window.__leMouseMove = function(fromX, fromY, toX, toY) {
            cursor.style.opacity = '1';
            cursor.style.transform = 'translate(' + fromX + 'px,' + fromY + 'px)';
            // 强制 reflow 后再移动到目标位置触发 transition
            void cursor.offsetWidth;
            setTimeout(() => {
              cursor.style.transform = 'translate(' + toX + 'px,' + toY + 'px)';
            }, 50);
            // 4 秒后淡出
            setTimeout(() => { cursor.style.opacity = '0'; }, 4000);
          };

          // ============ 3. 动作标签（页面顶部状态条） ============
          const labelBar = document.createElement('div');
          labelBar.id = '__le_action_label';
          labelBar.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);background:rgba(26,24,22,0.95);color:#fff;padding:8px 16px;border-radius:6px;font-size:13px;font-family:system-ui,sans-serif;z-index:1000002;box-shadow:0 2px 12px rgba(0,0,0,0.3);opacity:0;transition:opacity 0.3s;pointer-events:none;max-width:80vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
          document.body.appendChild(labelBar);

          window.__leShowLabel = function(text, durationMs) {
            durationMs = durationMs || 2000;
            labelBar.textContent = text;
            labelBar.style.opacity = '1';
            clearTimeout(window.__leLabelTimer);
            window.__leLabelTimer = setTimeout(() => {
              labelBar.style.opacity = '0';
            }, durationMs);
          };

          // ============ 4. 工具方法：根据 selector 查找元素 ============
          window.__leFindElement = function(selector) {
            try {
              return document.querySelector(selector);
            } catch (e) {
              return null;
            }
          };

          // ============ 5. 获取元素位置（含滚动偏移） ============
          window.__leGetElementRect = function(selector) {
            const el = window.__leFindElement(selector);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.left, y: r.top, width: r.width, height: r.height, centerX: r.left + r.width/2, centerY: r.top + r.height/2 };
          };

          // ============ 6. 模拟点击（带视觉效果） ============
          window.__leSimulateClick = function(selector) {
            const el = window.__leFindElement(selector);
            if (!el) return false;
            const r = el.getBoundingClientRect();
            // 先高亮
            window.__leHighlightElement(r, 1500);
            // 模拟鼠标事件序列
            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
              el.dispatchEvent(new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: r.left + r.width/2,
                clientY: r.top + r.height/2
              }));
            });
            return true;
          };

          // ============ 7. 模拟输入（带视觉效果） ============
          window.__leSimulateType = function(selector, text, clear) {
            const el = window.__leFindElement(selector);
            if (!el) return false;
            const r = el.getBoundingClientRect();
            window.__leHighlightElement(r, 1500);
            // React/Vue 等框架的受控 input 用自己的
            // value tracker 覆盖原生赋值——直接 el.value = x + InputEvent 不触发
            // 框架 setter，B 站/百度等 SPA 输入框 AI 输入无效（工具却返回成功）。
            // 方案：调 HTMLInputElement/HTMLTextAreaElement 原型上的原生 value setter
            // （绕过框架的实例属性拦截），再派发 input 事件——React 的 onChange 监听
            // 的是原生 input 事件，能正确收到。
            function setNativeValue(elm, value) {
              const proto = elm instanceof HTMLTextAreaElement
                ? window.HTMLTextAreaElement.prototype
                : elm instanceof HTMLSelectElement
                  ? window.HTMLSelectElement.prototype
                  : window.HTMLInputElement.prototype;
              const desc = Object.getOwnPropertyDescriptor(proto, 'value');
              if (desc && desc.set) desc.set.call(elm, value);
              else elm.value = value;
            }
            if (clear) {
              setNativeValue(el, '');
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
            // 模拟逐字输入（更真实）
            el.focus();
            let cur = clear ? '' : el.value;
            for (const ch of text) {
              cur += ch;
              setNativeValue(el, cur);
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
            }
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          };
        })();
      `

/** 页面快照脚本：遍历 DOM 生成可访问性树精简版（深度 8，原 4 太浅） */
export const SNAPSHOT_SCRIPT = `    (() => {
      const lines = [];
      const interactiveTags = new Set(['a','button','input','select','textarea','label','video','img']);
      const containerTags = new Set(['nav','main','article','section','form','table','ul','ol','li','header','footer','aside','h1','h2','h3','h4','h5','h6']);
      const walk = (el, depth) => {
        if (depth > 8) return;
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || '';
        const aria = el.getAttribute('aria-label') || '';
        const cls = el.getAttribute('class') || '';
        const href = tag === 'a' ? (el.getAttribute('href') || '') : '';
        const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
        // 交互元素、带 role/aria 的、带 class 的 div、容器标签都收集
        const isInteractive = interactiveTags.has(tag) || role;
        const isContainer = containerTags.has(tag);
        const isDivWithClass = tag === 'div' && cls;
        if (isInteractive || isContainer || isDivWithClass) {
          let label = role || tag;
          if (aria) label += ' [aria="' + aria + '"]';
          if (cls) label += ' .' + cls.split(' ').slice(0, 2).join('.');
          if (href) label += ' -> ' + href.slice(0, 50);
          if (text && tag !== 'div') label += ': ' + text;
          lines.push('  '.repeat(depth) + label);
        }
        for (const child of Array.from(el.children)) walk(child, depth + 1);
      };
      if (document.body) walk(document.body, 0);
      return lines.join('\\n');
    })()
`
