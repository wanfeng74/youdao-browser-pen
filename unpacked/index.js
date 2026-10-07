import { B as BasePage } from './base-page-bd62aef9.js';
import { n as normalizeBrowserLaunchMode } from './display-resolver-b7d76f5e.js';

const DEFAULT_BROWSER_URL = 'https://m.baidu.com/';

const ALLOWED_SCHEMES = ['http', 'https', 'about', 'file'];

// 自动进入浏览器的冷却时间(ms):WPE崩溃被踢回启动页后,10秒内不再自动重进,
// 避免「崩溃→自动重进→再崩溃」的无限循环。模块级变量在页面重建时仍保留。
let _lastAutoLaunchTime = 0;
const AUTO_LAUNCH_COOLDOWN_MS = 10000;

function normalizeLaunchUrl(url) {
  const value = `${url || ''}`.trim();
  if (!value) return DEFAULT_BROWSER_URL
  if (value === 'baidu') return DEFAULT_BROWSER_URL
  if (value === 'bing') return 'https://www.bing.com/'

  const schemeMatch = value.match(/^([a-z][a-z0-9+.-]*):/i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    return ALLOWED_SCHEMES.indexOf(scheme) >= 0 ? value : DEFAULT_BROWSER_URL
  }
  if (value.indexOf('://') >= 0) return DEFAULT_BROWSER_URL
  if (/\s/.test(value) || value.indexOf('.') < 0) {
    return `https://m.baidu.com/s?word=${encodeURIComponent(value)}`
  }
  // IP地址或localhost默认用HTTP(校园网登录页/路由器管理页通常是HTTP)
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value) || /^localhost/i.test(value)) {
    return `http://${value}`
  }
  return `https://${value}`
}

//

const DEFAULT_BROWSER_MODE = 'last';

var script = {
  name: 'index',
  data() {
    return {
      busy: false,
      statusText: 'Ready',
      messageText: '准备启动 Web 浏览器',
      detailText: '',
    }
  },
  mounted() {
    this.applyPageOptions(this.pageOptions(), true);
    // 点图标即进入浏览器:不再需要「启动浏览器」按钮。
    this.scheduleAutoLaunch();
  },
  onShow() {
    this.applyPageOptions(this.pageOptions(), true);
    this.scheduleAutoLaunch();
  },
  onNewOptions(options) {
    this.applyPageOptions(options || {}, true);
    this.scheduleAutoLaunch();
  },
  methods: {
    pageOptions() {
      return this.$page && this.$page.options ? this.$page.options : {}
    },
    applyPageOptions(options, resetTransient) {
      const pageOptions = options || {};
      const wasLaunching = this.busy || this.messageText === '正在进入浏览器';
      if (resetTransient || this.busy) {
        this.busy = false;
        this.statusText = 'Ready';
        this.messageText = '准备启动 Web 浏览器';
      }
      if (pageOptions.browserStatus) {
        this.detailText = `${pageOptions.browserStatus}`;
      } else if (resetTransient && wasLaunching) {
        this.detailText = '';
      }
    },
    readInitialUrl() {
      const page = this.$page || {};
      const app = typeof $falcon !== 'undefined' && $falcon.$app;
      const candidates = [
        page.loadOptions,
        page.newOptions,
        page.options,
        app && app.launchOptions,
      ];
      for (let i = 0; i < candidates.length; i += 1) {
        const options = candidates[i] || {};
        const raw = options.url || options.href || options.u;
        if (raw) {
          try {
            return normalizeLaunchUrl(decodeURIComponent(`${raw}`))
          } catch (err) {
            return normalizeLaunchUrl(raw)
          }
        }
      }
      return DEFAULT_BROWSER_URL
    },
    /**
     * 自动进入浏览器。
     *
     * 生命周期里 mounted / onShow / onNewOptions 都可能触发,必须去重,
     * 否则会连续 navTo 多次(frame 被反复创建,表现为闪屏)。
     * 从浏览器返回时(带 browserStatus)也不再自动进入,避免用户无法停留在本页。
     */
    scheduleAutoLaunch() {
      const self = this;
      if (self._autoLaunchTimer || self._autoLaunchDone) return
      const opts = self.pageOptions();
      if (opts && opts.browserStatus) return   // 从 frame 返回:不自动再进
      // 冷却时间:刚崩溃被踢回后短时间内不再自动重进,打破无限循环
      if (Date.now() - _lastAutoLaunchTime < AUTO_LAUNCH_COOLDOWN_MS) {
        console.warn('auto-launch suppressed: within cooldown after recent launch');
        return
      }
      // 稍等一拍,确保页面已挂载、选项已解析
      self._autoLaunchTimer = setTimeout(function () {
        self._autoLaunchTimer = null;
        if (self._autoLaunchDone) return
        self._autoLaunchDone = true;
        self.launchBrowser();
      }, 120);
    },
    launchBrowser() {
      if (this.busy) return
      this._autoLaunchDone = true;   // 标记已进入过,防止 onShow 再触发一次
      _lastAutoLaunchTime = Date.now();  // 记录进入时间,用于冷却去重
      this.busy = true;
      this.statusText = 'Starting';
      this.messageText = '正在进入浏览器';
      this.detailText = '';

      try {
        $falcon.navTo('frame', {
          url: this.readInitialUrl(),
          // 旋转模式不再在开屏页选择:统一用「沿用上次」,
          // 实际模式由浏览器内「设置 → 显示模式」决定并持久化到 display-mode 文件。
          browserMode: DEFAULT_BROWSER_MODE,
          returnPage: 'index',
        });
      } catch (err) {
        const message = err && err.message ? err.message : `${err}`;
        this.statusText = 'Error';
        this.messageText = '浏览器启动失败';
        this.detailText = message;
        console.warn(`launch browser nav failed ${message}`);
        this.busy = false;
      }
    },
  },
};

var style_0 = { "_": {
  "launcher-page": {
    "width": "100vw",
    "height": "100vh",
    "backgroundColor": "#0c1014",
    "color": "#f5f7fa",
    "alignItems": "center",
    "justifyContent": "center",
    "overflow": "hidden"
  },
  "launcher-shell": {
    "backgroundColor": "#0c1014",
    "color": "#f5f7fa",
    "width": "100vw",
    "height": "100vh"
  },
  "topbar": {
    "height": "38px",
    "paddingLeft": "12px",
    "paddingRight": "12px",
    "flexDirection": "row",
    "alignItems": "center",
    "justifyContent": "space-between",
    "backgroundColor": "#151b22"
  },
  "title": {
    "fontSize": "18px",
    "color": "#ffffff"
  },
  "status": {
    "fontSize": "14px",
    "color": "#8fd0ff"
  },
  "content": {
    "paddingLeft": "10px",
    "paddingRight": "10px",
    "paddingTop": "8px"
  },
  "message": {
    "fontSize": "18px",
    "color": "#ffffff"
  },
  "detail": {
    "marginTop": "8px",
    "fontSize": "15px",
    "color": "#ffb4a8"
  },
  "mode-block": {
    "marginTop": "8px"
  },
  "section-label": {
    "fontSize": "13px",
    "color": "#9fb1c0"
  },
  "mode-row": {
    "flexDirection": "row",
    "alignItems": "center",
    "marginTop": "5px"
  },
  "button-row": {
    "flexDirection": "row",
    "alignItems": "center"
  },
  "mode-option": {
    "marginRight": "6px",
    "width": "80px",
    "height": "40px",
    "lineHeight": "40px",
    "textAlign": "center",
    "borderRadius": "8px",
    "fontSize": "16px",
    "color": "#d9e6f2",
    "backgroundColor": "#26323d"
  },
  "mode-option-last": {
    "width": "110px"
  },
  "mode-option-active": {
    "color": "#081018",
    "backgroundColor": "#8fd0ff"
  },
  "primary-button": {
    "marginTop": "10px",
    "marginRight": "8px",
    "width": "220px",
    "height": "52px",
    "lineHeight": "52px",
    "textAlign": "center",
    "borderRadius": "10px",
    "fontSize": "20px",
    "color": "#081018",
    "backgroundColor": "#79d66b"
  }
} };

var render = function (){
var _vm=this;var _h=_vm.$createElement;var _c=_vm._self._c||_h;
  return _c('div', {
    staticClass: ["launcher-page"],
    on: {
      "click": function($event) {
        return _vm.launchBrowser()
      }
    }
  }, [_c('div', {
    staticClass: ["launcher-shell"]
  }, [_c('div', {
    staticClass: ["topbar"]
  }, [_c('text', {
    staticClass: ["title"]
  }, [_vm._v("Web浏览器")]), _c('text', {
    staticClass: ["status"]
  }, [_vm._v(_vm._s(_vm.statusText))])]), _c('div', {
    staticClass: ["content"]
  }, [_c('text', {
    staticClass: ["message"]
  }, [_vm._v(_vm._s(_vm.messageText))]), (_vm.detailText) ? _c('text', {
    staticClass: ["detail"]
  }, [_vm._v(_vm._s(_vm.detailText))]) : _vm._e()])])])
};

var staticRenderFns=[];
render._withStripped = true;
  
const __file = 'src/pages/index/index.vue';
const _scopeId = 'data-v-1badc801';

const _exports = script;

_exports.render = render;
_exports.staticRenderFns = staticRenderFns;
_exports._compiled = true;
_exports._scopeId = _scopeId;
_exports.themes = {};
_exports.style = Object.assign({}, style_0['_']);
_exports.__file = __file;

var IndexComponent = _exports;

class PageIndex extends BasePage {
  onLoad(options) {
    super.onLoad(options);
    this.setRootComponent(IndexComponent);
  }
}

export { PageIndex as default };
