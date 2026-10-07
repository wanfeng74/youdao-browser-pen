import { B as BasePage } from './base-page-bd62aef9.js';
import { browserPlayer } from 'browser';
import { b as browserDataPath, a as browserOptions, c as normalizeBrowserMode, L as LAST_BROWSER_MODE, k as keyboardBackendOverride } from './display-resolver-b7d76f5e.js';
import globalModule from 'global';

function parseBrowserExitStatus(raw) {
  if (!raw) return { reason: 'exited', code: null, browserMode: '', message: '浏览器已退出' }
  try {
    const status = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const code = Number(status.code);
    const normalizedCode = Number.isFinite(code) ? code : null;
    if (status.reason === 'rotation_change' && normalizedCode === 72) {
      return {
        reason: 'rotation_change',
        code: 72,
        browserMode: normalizeBrowserMode(status.browserMode),
        message: '正在应用显示方向',
      }
    }
    if (status.reason === 'user_shutdown') {
      return { reason: 'user_shutdown', code: normalizedCode, browserMode: '', message: '浏览器已关闭' }
    }
    if (status.reason === 'start_failed') {
      return { reason: 'start_failed', code: normalizedCode, browserMode: '', message: `浏览器启动失败（错误码 ${normalizedCode === null ? 'unknown' : normalizedCode}）` }
    }
    if (status.reason === 'crash') {
      return { reason: 'crash', code: normalizedCode, browserMode: '', message: `浏览器异常退出（错误码 ${normalizedCode === null ? 'unknown' : normalizedCode}）` }
    }
    return { reason: status.reason || 'exited', code: normalizedCode, browserMode: '', message: '浏览器已退出' }
  } catch (err) {
    console.warn(`parse browser exit status failed ${err}`);
    return { reason: 'invalid', code: null, browserMode: '', message: '浏览器已退出' }
  }
}

function createBrowserLifecycleState() {
  return {
    running: false,
    starting: false,
    leaving: false,
    startToken: 0,
    watchdogTimer: null,
    watchdogFailCount: 0,
    browserModeOverride: '',
    rotationRestartCount: 0,
    // 主动重启(换 URL / 换显示模式)期间的保护截止时间戳。
    // 这期间 WPE 被有意停掉,watchdog 不能把它当成异常退出。
    restartGraceUntil: 0,
  }
}

class BrowserLifecycle {
  constructor(component, browserPlayer, keyboardBridge) {
    this.component = component;
    this.browserPlayer = browserPlayer;
    this.keyboardBridge = keyboardBridge;
  }

  get state() {
    return this.component.browser
  }

  pageOptions() {
    const options = this.component.pageOptions();
    if (!this.state.browserModeOverride) return options
    return Object.assign({}, options, {
      browserMode: this.state.browserModeOverride,
    })
  }

  workdir() {
    const options = this.pageOptions();
    return options.workdir || browserDataPath('')
  }

  requireWorkdir() {
    const workdir = this.workdir();
    if (!workdir) throw new Error('MiniApp 数据目录不可用，已阻止浏览器启动')
    return workdir
  }

  async resolveOptions() {
    const opts = Object.assign({}, this.pageOptions());
    if (this.component.urlOverride) {
      opts.url = this.component.urlOverride;
    }
    // B站视频页→嵌入播放器兼容性转换(初始加载也覆盖)
    // WPE WebKit 605.x 播放B站H5播放器报4004(playurl API失败),
    // 转嵌入播放器 player.bilibili.com,其播放器更简单。
    try {
      const u = opts.url || '';
      const bvMatch = u.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/);
      const epMatch = u.match(/bilibili\.com\/bangumi\/play\/(ep[0-9]+|ss[0-9]+)/);
      if (bvMatch) {
        const bvid = bvMatch[1];
        const pageMatch = u.match(/[?&]p=(\d+)/);
        const page = pageMatch ? pageMatch[1] : '1';
        opts.url = 'https://player.bilibili.com/player.html?bvid=' + bvid
          + '&page=' + page + '&platform=html5&high_quality=0&danmaku=0&autoplay=0';
        console.warn('bilibili initial url redirected to embed: ' + opts.url);
      } else if (epMatch) {
        const epid = epMatch[1];
        opts.url = 'https://player.bilibili.com/player.html?ep_id=' + epid
          + '&platform=html5&high_quality=0&danmaku=0&autoplay=0';
        console.warn('bilibili bangumi redirected to embed: ' + opts.url);
      }
    } catch (e) { console.warn('bilibili initial redirect failed: ' + e); }
    console.warn('DIAGRESOLVE pageOptions=' + JSON.stringify(this.pageOptions()) +
      ' override=' + JSON.stringify(this.component.urlOverride) +
      ' chosen=' + JSON.stringify(opts.url));
    return browserOptions(this.component, this.browserPlayer, opts);
  }

  start() {
    console.warn('DIAGSTART starting=' + this.state.starting + ' leaving=' + this.state.leaving +
      ' token=' + this.state.startToken + ' override=' + JSON.stringify(this.component.urlOverride));
    if (this.state.starting || this.state.leaving) return
    try {
      this.requireWorkdir();
    } catch (err) {
      this.leaveFrame(err.message);
      return
    }
    try {
      if (this.browserPlayer.isBrowserRunning && this.browserPlayer.isBrowserRunning({ workdir: this.workdir() })) {
        this.state.running = true;
        this.startWatchdog();
        if (this.keyboardBridge) this.keyboardBridge.startPolling();
        return
      }
    } catch (err) {
      console.warn(`check browser running failed ${err}`);
    }

    this.state.starting = true;
    const token = this.state.startToken + 1;
    this.state.startToken = token;
    setTimeout(() => {
      if (token !== this.state.startToken || this.state.leaving) return
      this.resolveOptions().then((launchOptions) => {
        if (token !== this.state.startToken || this.state.leaving) return
        console.warn('wpe launch options url=' + JSON.stringify(launchOptions && launchOptions.url) +
          ' workdir=' + JSON.stringify(launchOptions && launchOptions.workdir) +
          ' override=' + JSON.stringify(this.component.urlOverride));
        const pid = this.browserPlayer.startBrowser(launchOptions);
        this.state.running = Number(pid) > 0;
        console.warn(`wpe browser pid ${pid}`);
        if (this.state.running) {
          // 新浏览器已确认起来,撤掉重启保护窗口
          this.state.restartGraceUntil = 0;
          this.startWatchdog();
          if (this.keyboardBridge) this.keyboardBridge.startPolling();
        } else {
          this.leaveFrame('start failed');
        }
      }).catch((err) => {
        console.warn(`start browser failed ${err}`);
        this.state.running = false;
        this.leaveFrame(err && err.message ? err.message : 'start exception');
      }).then(() => {
        this.state.starting = false;
      });
    }, 0);
  }

  startWatchdog() {
    if (this.state.watchdogTimer) return
    this.state.watchdogTimer = setInterval(() => this.watch(), 1000);
  }

  stopWatchdog() {
    if (this.state.watchdogTimer) {
      clearInterval(this.state.watchdogTimer);
      this.state.watchdogTimer = null;
    }
  }

  watch() {
    if (this.state.starting || this.state.leaving) return
    // 正在按新地址重启:这段时间 WPE 被主动停掉,进程天然「不在运行」。
    // 若在此判定为异常退出,就会误触发 leaveFrame 把页面踢回启动页,
    // 表现就是「点确认后黑屏,然后回到首页并加载默认的百度」。
    if (this.state.restartGraceUntil && Date.now() < this.state.restartGraceUntil) {
      return
    }
    let running = false;
    try {
      running = this.browserPlayer.isBrowserRunning({ workdir: this.workdir() });
    } catch (err) {
      console.warn(`watch browser failed ${err}`);
    }
    if (running) {
      this.state.running = true;
      this.state.watchdogFailCount = 0;
      return
    }
    // 连续失败计数:WPE 加载复杂页面时进程可能短暂无响应,
    // 一次 isBrowserRunning=false 就 leaveFrame 会导致「黑屏→百度→黑屏」循环。
    // 必须连续 3 次(约3秒)检测不到才判定为真正崩溃。
    this.state.watchdogFailCount += 1;
    console.warn(`watchdog: browser not running (fail ${this.state.watchdogFailCount}/3)`);
    if (this.state.watchdogFailCount < 3) {
      return
    }
    this.state.watchdogFailCount = 0;
    this.state.running = false;
    const status = this.consumeExitStatus();
    if (status.reason === 'rotation_change') {
      this.restartForRotation(status.browserMode);
      return
    }
    this.leaveFrame(status.message);
  }

  consumeExitStatus() {
    if (!this.browserPlayer.consumeBrowserExitStatus) return parseBrowserExitStatus('')
    try {
      const raw = this.browserPlayer.consumeBrowserExitStatus({ workdir: this.workdir() });
      return parseBrowserExitStatus(raw)
    } catch (err) {
      console.warn(`consume browser exit status failed ${err}`);
      return parseBrowserExitStatus('')
    }
  }

  restartForUrl(url) {
    this.stopWatchdog();
    this.state.startToken += 1;
    this.state.starting = false;
    this.state.running = false;
    this.component.currentDisplayUrl = url;
    this.component.urlOverride = url;
    console.warn('DIAGSET wrote override=' + JSON.stringify(this.component.urlOverride) +
      ' readback=' + JSON.stringify(this.component && this.component.urlOverride) +
      ' isComponentObj=' + (typeof this.component === 'object'));
    if (this.keyboardBridge) {
      this.keyboardBridge.stopPolling();
      this.keyboardBridge.cancelActiveRequest('url change');
    }
    const workdir = this.workdir();
    if (workdir && this.browserPlayer.stopBrowser) {
      try { this.browserPlayer.stopBrowser({ workdir }); } catch (err) {}
    }
    console.warn('wpe restart for url: ' + url);
    // 主动重启期间挂起异常退出判定,否则 watchdog 会把「我们主动停掉的 WPE」
    // 当成崩溃,调用 leaveFrame 把页面踢回启动页(→ 黑屏后回到百度)。
    this.state.restartGraceUntil = Date.now() + 15000;
    this.startWhenStopped(url, 0);
  }

  /**
   * 轮询等待旧浏览器进程退出,然后再启动(最多等 4s,超时兜底启动)。
   * 解决固定延时导致 start() 撞上未退出的旧进程、从而静默不启动的问题。
   */
  startWhenStopped(url, attempt) {
    const self = this;
    if (self.state.leaving) return
    let alive = false;
    try {
      alive = !!(self.browserPlayer.isBrowserRunning &&
        self.browserPlayer.isBrowserRunning({ workdir: self.workdir() }));
    } catch (err) {
      alive = false;
    }
    if (alive && attempt < 20) {
      setTimeout(() => self.startWhenStopped(url, attempt + 1), 200);
      return
    }
    if (alive) {
      console.warn('wpe restart: old process still alive after ' + (attempt * 200) + 'ms, starting anyway');
    } else {
      console.warn('wpe restart: old process gone after ~' + (attempt * 200) + 'ms, starting url=' + (url || '(same)'));
    }
    self.start();
    // 绝对兜底:重启流程可能被输入法切前后台打断,导致 start() 没真正拉起进程。
    // 这里再确认一次,没起来就强制再拉一次,避免停在黑屏。
    self.setTimeout_ && self.setTimeout_('restart-verify', function () {
      if (self.state.leaving) return
      let up = false;
      try {
        up = !!(self.browserPlayer.isBrowserRunning &&
          self.browserPlayer.isBrowserRunning({ workdir: self.workdir() }));
      } catch (e) { up = false; }
      if (!up) {
        console.warn('RESTARTVERIFY browser down, forcing start');
        self.state.restartGraceUntil = 0;
        self.state.starting = false;
        self.start();
      } else {
        console.warn('RESTARTVERIFY browser up, ok');
      }
    }, 4000);
  }

  restartForMode(mode) {
    const m = normalizeBrowserMode(mode);
    this.stopWatchdog();
    this.state.startToken += 1;
    this.state.starting = false;
    this.state.running = false;
    this.state.browserModeOverride = m;
    if (this.keyboardBridge) {
      this.keyboardBridge.stopPolling();
      this.keyboardBridge.cancelActiveRequest('mode change');
    }
    const workdir = this.workdir();
    if (workdir && this.browserPlayer.stopBrowser) {
      try { this.browserPlayer.stopBrowser({ workdir }); } catch (err) {}
    }
    console.warn('wpe restart for mode: ' + m);
    this.state.restartGraceUntil = Date.now() + 15000;
    this.startWhenStopped(null, 0);
  }

  restartForRotation(browserMode) {
    const mode = normalizeBrowserMode(browserMode);
    this.stopWatchdog();
    this.state.startToken += 1;
    this.state.starting = false;
    this.state.running = false;
    this.state.browserModeOverride = mode;
    this.state.rotationRestartCount += 1;
    if (this.keyboardBridge) {
      this.keyboardBridge.stopPolling();
      this.keyboardBridge.cancelActiveRequest('rotation change');
    }
    console.warn(`wpe rotation restart mode=${mode} count=${this.state.rotationRestartCount}`);
    this.startWhenStopped(null, 0);
  }

  stop() {
    this.stopWatchdog();
    this.state.startToken += 1;
    this.state.starting = false;
    this.state.running = false;
    if (this.keyboardBridge) {
      this.keyboardBridge.stopPolling();
      this.keyboardBridge.cancelActiveRequest('stop browser');
    }
    const workdir = this.workdir();
    if (!workdir) return
    try {
      this.browserPlayer.stopBrowser({ workdir });
    } catch (err) {
      console.warn(`stop browser failed ${err}`);
    }
  }

  leaveFrame(reason) {
    if (this.state.leaving) return
    this.state.leaving = true;
    console.warn(`wpe leave frame: ${reason}`);
    const options = this.pageOptions();
    this.stop();
    // 退出后强制确认WPE进程已被杀掉,避免残留占用内存。
    // 轮询isBrowserRunning,若仍存活则再次stopBrowser,最多重试5次。
    const self = this;
    let killAttempts = 0;
    const waitAndKill = setInterval(() => {
      let alive = false;
      try {
        alive = !!(self.browserPlayer.isBrowserRunning &&
          self.browserPlayer.isBrowserRunning({ workdir: self.workdir() }));
      } catch (e) { alive = false; }
      if (!alive || killAttempts >= 5) {
        clearInterval(waitAndKill);
        console.warn('wpe leave frame: process ' + (alive ? 'STILL ALIVE after ' + killAttempts + ' attempts' : 'confirmed dead') + ', navigating to index');
        try {
          $falcon.navTo(options.returnPage || 'index', {
            browserStatus: reason || 'stopped',
            browserMode: LAST_BROWSER_MODE,
          });
        } catch (err) {
          console.warn(`nav index failed ${err}`);
        }
        return
      }
      killAttempts += 1;
      console.warn('wpe leave frame: process still alive, force stop attempt ' + killAttempts);
      try { self.browserPlayer.stopBrowser({ workdir: self.workdir() }); } catch (e) {}
    }, 200);
  }
}

const MAX_EVENT_DEPTH = 5;

function hasOwn(value, key) {
  return !!(value && Object.prototype.hasOwnProperty.call(value, key))
}

function decodeKeyboardValue(value, depth) {
  if (depth > MAX_EVENT_DEPTH) return { found: false, text: '' }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
      try {
        const decoded = decodeKeyboardValue(JSON.parse(value), depth + 1);
        if (decoded.found) return decoded
      } catch (err) {
        // A normal input string may begin with a brace.
      }
    }
    return { found: true, text: value }
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { found: true, text: `${value}` }
  }
  if (!value || typeof value !== 'object') return { found: false, text: '' }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const result = decodeKeyboardValue(value[i], depth + 1);
      if (result.found) return result
    }
    return { found: false, text: '' }
  }

  const directKeys = ['value', 'text', 'contents'];
  for (let i = 0; i < directKeys.length; i += 1) {
    const key = directKeys[i];
    if (!hasOwn(value, key)) continue
    const result = decodeKeyboardValue(value[key], depth + 1);
    if (result.found) return result
  }

  const wrappers = ['detail', 'target', 'currentTarget'];
  for (let i = 0; i < wrappers.length; i += 1) {
    const key = wrappers[i];
    if (!hasOwn(value, key)) continue
    const result = decodeKeyboardValue(value[key], depth + 1);
    if (result.found) return result
  }

  if (Array.isArray(value.records)) {
    for (let i = 0; i < value.records.length; i += 1) {
      const result = decodeKeyboardValue(value.records[i], depth + 1);
      if (result.found) return result
    }
  }
  return { found: false, text: '' }
}

function normalizeKeyboardEvent(value) {
  return decodeKeyboardValue(value, 0)
}

function decodeTextEditResult(value, depth) {
  if (depth > MAX_EVENT_DEPTH) return null
  let payload = value;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload || '{}');
    } catch (err) {
      return null
    }
  }
  if (!payload || typeof payload !== 'object') return null
  if (hasOwn(payload, 'editConfirmed')) {
    const text = normalizeKeyboardEvent(payload);
    const confirmed = payload.editConfirmed === true ||
      payload.editConfirmed === 1 ||
      `${payload.editConfirmed}`.toLowerCase() === 'true';
    return {
      terminal: true,
      confirmed,
      found: text.found,
      text: text.text,
    }
  }
  const wrappers = Array.isArray(payload)
    ? payload
    : ['detail', 'target', 'currentTarget', 'value', 'records'];
  for (let i = 0; i < wrappers.length; i += 1) {
    const nested = Array.isArray(payload) ? wrappers[i] : payload[wrappers[i]];
    if (!Array.isArray(payload) && !hasOwn(payload, wrappers[i])) continue
    const result = decodeTextEditResult(nested, depth + 1);
    if (result) return result
  }
  return null
}

function parseTextEditResult(value) {
  const result = decodeTextEditResult(value, 0);
  if (result) return result
  const text = normalizeKeyboardEvent(value);
  return {
    terminal: false,
    confirmed: false,
    found: text.found,
    text: text.text,
  }
}

let globalManager = null;

function getGlobalModule() {
  if (!globalManager) {
    try {
      const mod = globalModule;
      const Ctor = (mod && (mod.default && mod.default.Global || mod.Global || mod.default)) || (typeof Global !== 'undefined' && (Global.Global || Global.default || Global));
      if (Ctor && typeof Ctor === 'function') {
        globalManager = new Ctor();
      } else if (Ctor) {
        globalManager = Ctor;
      }
    } catch (err) {
      console.warn('create globalManager failed: ' + err);
    }
  }
  return globalManager || {};
}

function clampMaxlength(value) {
  let maxlength = value == null ? 100 : Number(value);
  if (!Number.isFinite(maxlength)) maxlength = 100;
  if (maxlength !== -1) maxlength = Math.max(1, Math.min(maxlength || 100, 4096));
  return maxlength
}

class KeyboardSession {
  constructor({ onConfirm, onCancel } = {}) {
    this.activeUuid = '';
    this.editFinished = null;
    this.onConfirm = onConfirm;
    this.onCancel = onCancel;
    this.stripNewlines = true;
    this.closeDelayMs = 350;
    this.closedUuids = {};
    this.closeTimers = {};
  }

  mount() {
    if (this.editFinished) return
    const gm = getGlobalModule();
    this.editFinished = (uuid, jsonData) => {
      if (!this.activeUuid || uuid !== this.activeUuid) {
        if (uuid) console.warn(`keyboard global result ignored uuid=${uuid} active=${this.activeUuid}`);
        return
      }
      const result = parseTextEditResult(jsonData);
      // 诊断:原样打印 payload,便于确认固件实际字段(确认后无反应的问题定位)
      try { console.warn('keyboard raw payload: ' + JSON.stringify(jsonData)); } catch (e) {}
      try {
        console.warn('keyboard parsed: terminal=' + result.terminal +
          ' confirmed=' + result.confirmed + ' found=' + result.found +
          ' text=' + JSON.stringify(result.text));
      } catch (e) {}
      setTimeout(() => {
        if (!this.activeUuid || uuid !== this.activeUuid) return
        if (result.confirmed) {
          // 兼容 found=false 的固件:直接取文本,而不是丢弃为空串
          this.finish(result.text || '');
        } else {
          this.cancel();
        }
      }, 0);
    };
    if (gm.textEditFinished && gm.textEditFinished.on) {
      gm.textEditFinished.on(this.editFinished);
      console.warn('keyboard global listener mounted');
    } else {
      console.warn('keyboard global listener unavailable');
    }
  }

  unmount() {
    const gm = getGlobalModule();
    if (gm.textEditFinished && gm.textEditFinished.off && this.editFinished) {
      gm.textEditFinished.off(this.editFinished);
    }
    this.editFinished = null;
    this.close();
  }

  open(options = {}) {
    // 旧会话残留时直接返回会导致后续点击「没反应」。
    // 这里主动收掉旧会话再重新打开,保证每次点击都能弹出输入法。
    if (this.activeUuid) {
      console.warn('keyboard open: closing stale uuid=' + this.activeUuid);
      const stale = this.activeUuid;
      this.activeUuid = '';
      this.closeUuid(stale, 'stale-reopen');
    }
    this.stripNewlines = options.stripNewlines !== false;
    this.closeDelayMs = options.closeDelayMs == null ? 350 : options.closeDelayMs;
    const gm = getGlobalModule();
    if (!gm.startTextEdit) {
      console.warn('keyboard global startTextEdit unavailable');
      return ''
    }

    const config = {
      text: `${options.text || ''}`,
      placeholder: options.placeholder || '',
      autofocus: true,
      maxlength: clampMaxlength(options.maxlength),
      showCursor: true,
      cursorColor: options.cursorColor || '#008CFF',
      cursorSize: options.cursorSize || 3,
      confirmButtonDisabledOnTextEmpty: options.confirmButtonDisabledOnTextEmpty !== false,
      inputType: options.inputType || 'ZhCNPreferred',
      multiLinesEditVisible: !!options.multiLinesEditVisible,
      capsLockSwitchOn: false,
      enterButtonText: options.enterButtonText || '确认',
    };

    try {
      this.activeUuid = gm.startTextEdit(JSON.stringify(config)) || '';
      console.warn(`keyboard global startTextEdit string uuid ${this.activeUuid || 'empty'}`);
    } catch (err) {
      this.activeUuid = '';
      console.warn(`keyboard global startTextEdit string failed ${err}`);
    }
    return this.activeUuid
  }

  finish(text) {
    if (!this.activeUuid) return
    const uuid = this.activeUuid;
    const value = `${text || ''}`;
    const cleaned = this.stripNewlines ? value.replace(/\n/g, '') : value;
    try {
      if (this.onConfirm) this.onConfirm(cleaned);
    } catch (err) {
      console.warn(`keyboard confirm handler failed ${err}`);
    }
    this.deferClose(uuid);
    this.activeUuid = '';
  }

  cancel() {
    if (!this.activeUuid) return
    const uuid = this.activeUuid;
    try {
      if (this.onCancel) this.onCancel();
    } catch (err) {
      console.warn(`keyboard cancel handler failed ${err}`);
    }
    this.deferClose(uuid);
    this.activeUuid = '';
  }

  deferClose(uuid) {
    if (!uuid || this.closedUuids[uuid] || this.closeTimers[uuid]) return
    this.closeTimers[uuid] = setTimeout(() => {
      delete this.closeTimers[uuid];
      this.closeUuid(uuid, 'deferred');
    }, this.closeDelayMs);
  }

  closeUuid(uuid, reason) {
    if (!uuid || this.closedUuids[uuid]) return
    if (this.closeTimers[uuid]) {
      clearTimeout(this.closeTimers[uuid]);
      delete this.closeTimers[uuid];
    }
    this.closedUuids[uuid] = true;
    setTimeout(() => { delete this.closedUuids[uuid]; }, 60000);
    const gm = getGlobalModule();
    if (!gm.closeTextEdit) return
    try {
      gm.closeTextEdit(uuid);
      console.warn(`keyboard global closeTextEdit uuid=${uuid} reason=${reason || ''}`);
    } catch (err) {
      console.warn(`keyboard closeTextEdit failed ${err}`);
    }
  }

  close() {
    const uuid = this.activeUuid;
    if (!uuid) return
    this.activeUuid = '';
    this.closeUuid(uuid, 'session close');
  }

  isActive() {
    return !!this.activeUuid
  }
}

const TEXTAREA_PROBE_MS = 1500;
const BACKEND_SWITCH_SETTLE_MS = 250;
const TEXTAREA_RETURN_CANCEL_MS = 800;
const COMPLETION_TIMEOUT_MS = 15000;
// Native keeps a keyboard request alive for up to 120 seconds. Remember a
// locally completed request beyond that window so a delayed/missing
// completion file cannot reopen the same keyboard session.
const COMPLETED_REQUEST_TTL_MS = 130000;
const RESPONSE_RETRY_DELAYS_MS = [100, 250, 500, 1000, 1500, 2000, 2500];

function createKeyboardBridgeState() {
  return {
    profileMode: 'auto',
    profileSource: 'probe',
    profileOverride: 'auto',
    phase: 'idle',
    session: null,
    pollTimer: null,
    pollTick: 0,
    activeRequest: null,
    activeBackend: '',
    attemptedBackends: {},
    probeTimer: null,
    backendSwitchTimer: null,
    returnCancelTimer: null,
    sequence: 0,
    lastUpdateText: null,
    completionDeadline: 0,
    responseRetryTimer: null,
    responseRetryAttempt: 0,
    pendingResponse: null,
    completedRequestIds: {},
    textareaVisible: false,
    textareaFocused: false,
    textareaBlurred: false,
    textareaValue: '',
    textareaInputType: 'ZhCNPreferred',
    textareaMaxlength: 512,
    textareaSeenInput: false,
  }
}

class KeyboardBridge {
  constructor(component, browserPlayer, workdirGetter, runningGetter) {
    this.component = component;
    this.browserPlayer = browserPlayer;
    this.workdirGetter = workdirGetter;
    this.runningGetter = runningGetter;
  }

  get state() {
    return this.component.keyboard
  }

  workdir() {
    return this.workdirGetter ? this.workdirGetter() : ''
  }

  setup() {
    if (!this.workdir()) {
      console.warn('keyboard bridge disabled: browser workdir is unavailable');
      return
    }
    this.readProfile();
    if (this.state.session) return
    this.state.session = new KeyboardSession({
      onConfirm: (text) => this.finishRequest(true, text),
      onCancel: () => this.finishRequest(false, ''),
    });
    this.state.session.mount();
  }

  teardown() {
    this.stopPolling();
    this.clearBackendTimers();
    this.clearResponseRetryTimer();
    if (this.state.activeRequest && this.state.phase !== 'responding') {
      this.writeResponse(false, '');
    }
    this.closeLocalKeyboard();
    this.resetActiveRequest('teardown', false);
    if (this.state.session) {
      this.state.session.unmount();
      this.state.session = null;
    }
  }

  readProfile() {
    let profile = null;
    this.state.profileOverride = keyboardBackendOverride();
    try {
      if (this.browserPlayer.getKeyboardProfile) {
        const raw = this.browserPlayer.getKeyboardProfile({
          workdir: this.workdir(),
          override: this.state.profileOverride,
        }) || '';
        profile = raw ? JSON.parse(raw) : null;
      }
    } catch (err) {
      console.warn(`read keyboard profile failed ${err}`);
    }
    const mode = profile && `${profile.mode || ''}`;
    this.state.profileMode = mode === 'textarea' || mode === 'global' ? mode : 'auto';
    this.state.profileSource = profile && profile.source ? `${profile.source}` : 'probe';
    console.warn(`keyboard profile mode=${this.state.profileMode} source=${this.state.profileSource} override=${this.state.profileOverride}`);
  }

  reportBackend(backend, successful, evidence) {
    if (!this.browserPlayer.reportKeyboardBackend || this.state.profileOverride !== 'auto') return
    try {
      this.browserPlayer.reportKeyboardBackend({
        workdir: this.workdir(),
        backend,
        successful: !!successful,
        evidence: evidence || '',
      });
    } catch (err) {
      console.warn(`report keyboard backend failed ${err}`);
    }
  }

  markBackendSuccess(backend, evidence) {
    if (!backend || this.state.activeBackend !== backend) return
    if (backend === 'textarea') this.clearProbeTimer();
    if (this.state.profileOverride === 'auto') {
      const shouldPersist = this.state.profileMode !== backend ||
        this.state.profileSource !== 'learned';
      this.state.profileMode = backend;
      this.state.profileSource = 'learned';
      if (shouldPersist) this.reportBackend(backend, true, evidence);
    }
    console.warn(`keyboard backend ready backend=${backend} evidence=${evidence || ''}`);
  }

  startPolling() {
    if (this.state.pollTimer) return
    this.state.pollTimer = setInterval(() => this.onPollTick(), 200);
    this.pollRequest();
  }

  stopPolling() {
    if (!this.state.pollTimer) return
    clearInterval(this.state.pollTimer);
    this.state.pollTimer = null;
  }

  onPollTick() {
    this.state.pollTick += 1;
    this.pruneCompletedRequests();
    if (this.state.activeRequest) {
      this.pollCompletion();
      if (this.state.phase === 'responding' && this.state.completionDeadline > 0 &&
          Date.now() >= this.state.completionDeadline) {
        console.warn(`keyboard completion timeout id=${this.state.activeRequest.id}`);
        this.resetActiveRequest('completion timeout');
      }
      return
    }
    if (this.state.pollTick % 3 === 0) this.pollRequest();
  }

  reconcileActiveRequest() {
    if (this.state.activeRequest) {
      this.pollCompletion();
      return false
    }
    this.pollRequest();
    return false
  }

  pollCompletion() {
    const request = this.state.activeRequest;
    if (!request || !request.id || !this.browserPlayer.pollKeyboardCompletion) return
    let raw = '';
    try {
      raw = this.browserPlayer.pollKeyboardCompletion({
        workdir: this.workdir(),
        id: request.id,
      }) || '';
    } catch (err) {
      console.warn(`poll keyboard completion failed ${err}`);
      return
    }
    if (!raw) return
    let completion = null;
    try {
      completion = JSON.parse(raw);
    } catch (err) {
      console.warn(`parse keyboard completion failed id=${request.id} ${err}`);
      return
    }
    if (!completion || `${completion.id || ''}` !== `${request.id}` || !completion.status) return
    try {
      if (this.browserPlayer.ackKeyboardCompletion) {
        this.browserPlayer.ackKeyboardCompletion({
          workdir: this.workdir(),
          id: request.id,
        });
      }
    } catch (err) {
      console.warn(`ack keyboard completion failed id=${request.id} ${err}`);
      return
    }
    console.warn(`keyboard completion id=${request.id} status=${completion.status} detail=${completion.detail || ''}`);
    this.resetActiveRequest(`native ${completion.status}`);
  }

  optionsForRequest(request) {
    const kind = request && request.kind ? `${request.kind}` : '';
    const text = request && request.text != null ? `${request.text}` : '';
    const placeholder = request && request.placeholder
      ? `${request.placeholder}`
      : (kind === 'web_input' ? '请输入内容' : '输入网址或搜索');
    const inputType = request && request.inputType
      ? `${request.inputType}`
      : (kind === 'web_input' ? 'ZhCNPreferred' : 'EnUSPreferred');
    let maxlength = request && request.maxlength != null ? Number(request.maxlength) : 512;
    if (!Number.isFinite(maxlength)) maxlength = 512;
    return {
      text,
      placeholder,
      maxlength,
      inputType,
      multiLinesEditVisible: !!(request && request.multiLinesEditVisible),
      stripNewlines: !(request && request.multiLinesEditVisible),
      confirmButtonDisabledOnTextEmpty: false,
      enterButtonText: '确认',
    }
  }

  preferredBackend() {
    return this.state.profileMode === 'global' ? 'global' : 'textarea'
  }

  openBackend(request, backend) {
    if (!this.isCurrentRequest(request.id)) return false
    this.state.activeBackend = backend;
    this.state.attemptedBackends[backend] = true;
    return backend === 'textarea' ? this.openTextarea(request) : this.openGlobal(request)
  }

  openTextarea(request) {
    const options = this.optionsForRequest(request);
    this.state.textareaValue = options.text;
    this.state.textareaInputType = options.inputType;
    this.state.textareaMaxlength = options.maxlength || 512;
    this.state.textareaVisible = true;
    this.state.textareaFocused = false;
    this.state.textareaBlurred = false;
    this.state.textareaSeenInput = false;
    this.state.phase = 'opening';
    console.warn(`keyboard textarea request id=${request.id} kind=${request.kind || ''} type=${options.inputType}`);
    setTimeout(() => {
      if (!this.isCurrentRequest(request.id) || this.state.activeBackend !== 'textarea' ||
          this.state.phase !== 'opening') return
      this.state.textareaFocused = true;
      try {
        const field = this.component.$refs.keyboardTextarea;
        if (field && field.focus) field.focus();
      } catch (err) {
        console.warn(`keyboard textarea focus failed ${err}`);
        this.failBackend('textarea', 'focus_error');
        return
      }
      this.startTextareaProbe(request.id);
    }, 0);
    return true
  }

  startTextareaProbe(requestId) {
    this.clearProbeTimer();
    this.state.probeTimer = setTimeout(() => {
      this.state.probeTimer = null;
      if (!this.isCurrentRequest(requestId) || this.state.activeBackend !== 'textarea') return
      console.warn(`keyboard textarea probe timeout id=${requestId}`);
      this.failBackend('textarea', 'probe_timeout');
    }, TEXTAREA_PROBE_MS);
  }

  openGlobal(request) {
    if (!this.state.session) return false
    this.closeTextarea();
    // 网页输入请求必须使用 KeyboardBridge 自己的处理器:
    // 地址栏/主页编辑可能残留自定义 onConfirm/onCancel,不重置会导致
    // 网页输入文本被当成网址导航或被存成主页(网页永远收不到文本)。
    this.restoreSessionHandlers();
    this.state.phase = 'opening';
    const uuid = this.state.session.open(this.optionsForRequest(request));
    if (uuid) {
      this.state.phase = 'active';
      this.markBackendSuccess('global', 'uuid');
    }
    console.warn(`keyboard global request id=${request.id} kind=${request.kind || ''} uuid=${uuid || ''}`);
    if (!uuid) this.failBackend('global', 'empty_uuid');
    return !!uuid
  }

  failBackend(backend, evidence) {
    const request = this.state.activeRequest;
    if (!request || this.state.activeBackend !== backend || this.state.phase === 'responding') return
    this.reportBackend(backend, false, evidence);
    if (backend === 'global' && this.state.session && this.state.session.isActive()) {
      this.state.session.close();
    }
    if (backend === 'textarea') this.closeTextarea();
    const fallback = backend === 'textarea' ? 'global' : 'textarea';
    const allowFallback = this.state.profileOverride === 'auto' && !this.state.attemptedBackends[fallback];
    if (!allowFallback) {
      this.finishRequest(false, '');
      return
    }
    this.state.phase = 'opening';
    this.clearBackendSwitchTimer();
    this.state.backendSwitchTimer = setTimeout(() => {
      this.state.backendSwitchTimer = null;
      if (!this.isCurrentRequest(request.id) || this.state.phase !== 'opening') return
      console.warn(`keyboard backend fallback from=${backend} to=${fallback} id=${request.id}`);
      this.openBackend(request, fallback);
    }, BACKEND_SWITCH_SETTLE_MS);
  }

  clearProbeTimer() {
    if (!this.state.probeTimer) return
    clearTimeout(this.state.probeTimer);
    this.state.probeTimer = null;
  }

  clearBackendSwitchTimer() {
    if (!this.state.backendSwitchTimer) return
    clearTimeout(this.state.backendSwitchTimer);
    this.state.backendSwitchTimer = null;
  }

  clearReturnCancelTimer() {
    if (!this.state.returnCancelTimer) return
    clearTimeout(this.state.returnCancelTimer);
    this.state.returnCancelTimer = null;
  }

  clearBackendTimers() {
    this.clearProbeTimer();
    this.clearBackendSwitchTimer();
    this.clearReturnCancelTimer();
  }

  clearResponseRetryTimer() {
    if (!this.state.responseRetryTimer) return
    clearTimeout(this.state.responseRetryTimer);
    this.state.responseRetryTimer = null;
  }

  closeTextarea() {
    this.clearProbeTimer();
    this.state.textareaFocused = false;
    this.state.textareaVisible = false;
    this.state.textareaBlurred = false;
    this.state.textareaSeenInput = false;
  }

  closeLocalKeyboard() {
    if (this.state.session && this.state.session.isActive()) this.state.session.close();
    this.closeTextarea();
  }

  onTextareaInput(value) {
    if (!this.state.activeRequest || this.state.activeBackend !== 'textarea' ||
        this.state.phase === 'responding') return
    const normalized = normalizeKeyboardEvent(value);
    if (!normalized.found) {
      console.warn('keyboard textarea input ignored: no text field');
      return
    }
    this.markBackendSuccess('textarea', 'input');
    this.state.phase = 'active';
    this.state.textareaValue = normalized.text;
    this.state.textareaSeenInput = true;
    if (this.state.lastUpdateText === normalized.text) return
    this.state.lastUpdateText = normalized.text;
    this.state.sequence += 1;
    this.updateRequest(normalized.text, this.state.sequence);
  }

  onTextareaConfirm(value) {
    if (!this.state.activeRequest || this.state.activeBackend !== 'textarea' ||
        this.state.phase === 'responding') return
    const normalized = normalizeKeyboardEvent(value);
    this.markBackendSuccess('textarea', 'confirm');
    const text = this.state.textareaSeenInput
      ? this.state.textareaValue
      : (normalized.found ? normalized.text : this.state.textareaValue);
    this.finishRequest(true, text);
  }

  onTextareaFinished(value) {
    if (!this.state.activeRequest || this.state.activeBackend !== 'textarea' ||
        this.state.phase === 'responding') return
    const result = parseTextEditResult(value);
    if (!result.terminal) {
      if (result.found) this.onTextareaInput(result.text);
      return
    }
    this.markBackendSuccess('textarea', 'textEditFinished');
    if (!result.confirmed) {
      this.finishRequest(false, '');
      return
    }
    const text = this.state.textareaSeenInput
      ? this.state.textareaValue
      : (result.found ? result.text : this.state.textareaValue);
    this.finishRequest(true, text);
  }

  onTextareaFocus() {
    this.state.textareaFocused = true;
    this.state.textareaBlurred = false;
    this.clearReturnCancelTimer();
    console.warn('keyboard textarea focused');
  }

  onTextareaBlur() {
    this.state.textareaFocused = false;
    this.state.textareaBlurred = true;
    console.warn('keyboard textarea blurred; waiting for page return or terminal event');
  }

  onPageHide() {
    if (!this.isActive()) return false
    if (this.state.activeBackend === 'textarea' &&
        (this.state.phase === 'opening' || this.state.phase === 'active')) {
      this.markBackendSuccess('textarea', 'page_hide');
      this.state.phase = 'active';
    }
    return true
  }

  onPageShow() {
    this.clearReturnCancelTimer();
    if (!this.state.activeRequest || this.state.activeBackend !== 'textarea' ||
        !this.state.textareaBlurred || this.state.phase === 'responding') return
    const requestId = this.state.activeRequest.id;
    this.state.returnCancelTimer = setTimeout(() => {
      this.state.returnCancelTimer = null;
      if (!this.isCurrentRequest(requestId) || this.state.textareaFocused ||
          !this.state.textareaBlurred || this.state.phase === 'responding') return
      console.warn(`keyboard textarea cancelled after page return id=${requestId}`);
      this.finishRequest(false, '');
    }, TEXTAREA_RETURN_CANCEL_MS);
  }

  updateRequest(text, sequence) {
    const request = this.state.activeRequest;
    if (!request || !request.id || !this.browserPlayer.updateKeyboardRequest) return
    try {
      this.browserPlayer.updateKeyboardRequest({
        workdir: this.workdir(),
        id: request.id,
        sequence,
        text,
      });
      console.warn(`keyboard update id=${request.id} backend=${this.state.activeBackend} kind=${request.kind || ''} sequence=${sequence} bytes=${text.length}`);
    } catch (err) {
      console.warn(`update keyboard request failed ${err}`);
    }
  }

  pollRequest() {
    if (this.component.browser.leaving || this.state.phase !== 'idle') return
    if (!this.browserPlayer.pollKeyboardRequest || !this.state.session) return
    if (this.runningGetter && !this.runningGetter()) return

    let raw = '';
    try {
      raw = this.browserPlayer.pollKeyboardRequest({ workdir: this.workdir() }) || '';
    } catch (err) {
      console.warn(`poll keyboard request failed ${err}`);
      return
    }
    if (!raw) return
    let request = null;
    try {
      request = JSON.parse(raw);
    } catch (err) {
      console.warn(`parse keyboard request failed ${err}`);
      return
    }
    if (!request || !request.id || this.state.completedRequestIds[request.id]) return

    this.state.activeRequest = request;
    this.state.activeBackend = '';
    this.state.attemptedBackends = {};
    this.state.sequence = 0;
    this.state.lastUpdateText = request.text == null ? '' : `${request.text}`;
    this.state.completionDeadline = 0;
    console.warn(`keyboard request id=${request.id} kind=${request.kind || ''} preferred=${this.preferredBackend()}`);
    this.openBackend(request, this.preferredBackend());
  }

  writeResponse(confirmed, text) {
    const request = this.state.activeRequest;
    if (!request || !request.id) return false
    try {
      const result = this.browserPlayer.respondKeyboardRequest({
        workdir: this.workdir(),
        id: request.id,
        sequence: this.state.sequence,
        confirmed: !!confirmed,
        text: confirmed ? text : '',
      });
      if (result === false) return false
      console.warn(`keyboard ${confirmed ? 'confirmed' : 'cancelled'} id=${request.id} backend=${this.state.activeBackend} kind=${request.kind || ''} sequence=${this.state.sequence}`);
      return true
    } catch (err) {
      console.warn(`respond keyboard request failed ${err}`);
      return false
    }
  }

  publishPendingResponse() {
    const request = this.state.activeRequest;
    const response = this.state.pendingResponse;
    if (!request || !response || this.state.phase !== 'responding') return
    this.clearResponseRetryTimer();
    if (this.writeResponse(response.confirmed, response.text)) {
      this.state.pendingResponse = null;
      this.state.responseRetryAttempt = 0;
      this.closeLocalKeyboard();
      return
    }

    const attempt = this.state.responseRetryAttempt;
    if (attempt >= RESPONSE_RETRY_DELAYS_MS.length) {
      console.warn(`keyboard terminal response abandoned id=${request.id} attempts=${attempt + 1}`);
      this.closeLocalKeyboard();
      this.resetActiveRequest('terminal response write failed');
      return
    }
    const delay = RESPONSE_RETRY_DELAYS_MS[attempt];
    this.state.responseRetryAttempt += 1;
    console.warn(`keyboard terminal response retry id=${request.id} attempt=${attempt + 1} delay=${delay}`);
    this.state.responseRetryTimer = setTimeout(() => {
      this.state.responseRetryTimer = null;
      this.publishPendingResponse();
    }, delay);
  }

  finishRequest(confirmed, value) {
    if (!this.state.activeRequest || this.state.phase === 'responding') return
    const normalized = normalizeKeyboardEvent(value);
    const text = normalized.found ? normalized.text : '';
    if (confirmed && text !== this.state.lastUpdateText) {
      this.state.lastUpdateText = text;
      this.state.sequence += 1;
    }
    this.state.phase = 'responding';
    this.state.completionDeadline = Date.now() + COMPLETION_TIMEOUT_MS;
    this.clearBackendTimers();
    this.state.pendingResponse = { confirmed: !!confirmed, text };
    this.state.responseRetryAttempt = 0;
    this.publishPendingResponse();
  }

  resetActiveRequest(reason, notify = true) {
    const request = this.state.activeRequest;
    if (request && request.id) {
      this.state.completedRequestIds[request.id] = Date.now() + COMPLETED_REQUEST_TTL_MS;
    }
    this.clearBackendTimers();
    this.clearResponseRetryTimer();
    this.closeLocalKeyboard();
    this.state.activeRequest = null;
    this.state.activeBackend = '';
    this.state.attemptedBackends = {};
    this.state.sequence = 0;
    this.state.lastUpdateText = null;
    this.state.completionDeadline = 0;
    this.state.responseRetryAttempt = 0;
    this.state.pendingResponse = null;
    this.state.phase = 'idle';
    console.warn(`keyboard session reset reason=${reason || ''}`);
    if (notify) this.notifyInactive();
  }

  pruneCompletedRequests() {
    const now = Date.now();
    Object.keys(this.state.completedRequestIds).forEach((id) => {
      if (this.state.completedRequestIds[id] <= now) delete this.state.completedRequestIds[id];
    });
  }

  isCurrentRequest(id) {
    return !!(this.state.activeRequest && `${this.state.activeRequest.id}` === `${id}`)
  }

  notifyInactive() {
    if (!this.component || !this.component.onKeyboardBridgeInactive) return
    setTimeout(() => this.component.onKeyboardBridgeInactive(), 0);
  }

  cancelActiveRequest(reason) {
    if (!this.state.activeRequest) {
      this.closeLocalKeyboard();
      return
    }
    console.warn(`keyboard cancel active reason=${reason || ''} id=${this.state.activeRequest.id}`);
    if (this.state.phase !== 'responding') this.writeResponse(false, '');
    this.resetActiveRequest(reason || 'cancelled');
  }

  isActive() {
    return this.state.phase !== 'idle' ||
      !!(this.state.session && this.state.session.isActive()) ||
      this.state.textareaVisible
  }

  /**
   * 把输入法会话的确认/取消处理器统一归还给 KeyboardBridge。
   *
   * 地址栏输入(openUrlKeyboard)与主页编辑(editSettingsHome)会临时接管
   * session.onConfirm/onCancel。若这些临时处理器没有在会话结束时恢复,
   * 之后网页里的输入框会继续触发「地址栏/主页」逻辑:
   *   - 输入账号 → 被当成新网址导航(跳百度搜索)
   *   - 输入内容 → 被当成新主页保存
   * 网页永远收不到文本,表现为"某些网页的移动交互存在bug"。
   * 因此所有接管路径都必须通过 restoreSessionHandlers() 归还。
   */
  restoreSessionHandlers() {
    const session = this.state.session;
    if (!session) return
    const bridge = this;
    session.onConfirm = function (text) {
      try { bridge.finishRequest(true, text); } catch (e) {
        console.warn('bridge finishRequest failed ' + e);
      }
    };
    session.onCancel = function () {
      try { bridge.finishRequest(false, ''); } catch (e) {}
    };
  }
}

//

var script = {
  name: 'frame',
  data() {
    return {
      browser: createBrowserLifecycleState(),
      keyboard: createKeyboardBridgeState(),
      browserLifecycle: null,
      keyboardBridge: null,
      pageVisible: true,
      keyboardHideTimer: null,
      currentDisplayUrl: '',
      urlOverride: '',
      // 浏览历史栈:用于「返回」按钮回到上一个页面
      urlHistory: [],
      // 地址栏专用状态(与网页输入隔离,避免账号被当成网址)
      addressBarEditing: false,
      addressBarText: '',
      // 按新地址重启期间的保护窗口(见 onHide)
      urlRestartUntil: 0,
      showSettings: false,
      navBarExpanded: false,
      settingsHome: 'https://m.baidu.com/',
      settingsSearch: 'baidu',
      settingsMode: 'last',
    }
  },
  mounted() {
    this.ensureControllers();
    const initOpts = this.pageOptions();
    this.currentDisplayUrl = initOpts.url || 'https://m.baidu.com/';
    if (this.browserWorkdir()) {
      this.keyboardBridge.setup();
    }
    this.browserLifecycle.start();
  },
  beforeDestroy() {
    this.teardownControllers();
  },
  methods: {
    ensureControllers() {
      if (!this.keyboardBridge) {
        this.keyboardBridge = new KeyboardBridge(
          this,
          browserPlayer,
          () => this.browserWorkdir(),
          () => this.browser.running || this.browser.starting,
        );
      }
      if (!this.browserLifecycle) {
        this.browserLifecycle = new BrowserLifecycle(this, browserPlayer, this.keyboardBridge);
      }
    },
    teardownControllers() {
      this.clearKeyboardHideTimer();
      if (this.browserLifecycle) {
        this.browserLifecycle.stop();
        // 页面彻底销毁时多次强制stopBrowser,确保WPE进程被杀掉不残留占用内存
        try {
          const wd = this.browserLifecycle.workdir();
          if (wd && this.browserPlayer.stopBrowser) {
            for (let i = 0; i < 3; i++) {
              try { this.browserPlayer.stopBrowser({ workdir: wd }); } catch (e) {}
            }
          }
        } catch (e) { console.warn('force stop on teardown failed: ' + e); }
      }
      if (this.keyboardBridge) {
        this.keyboardBridge.teardown();
      }
      if (this.browserLifecycle) {
        this.browserLifecycle.stopWatchdog();
      }
    },
    pageOptions() {
      return this.$page && this.$page.options ? this.$page.options : {}
    },
    browserWorkdir() {
      const options = this.pageOptions();
      return options.workdir || browserDataPath('')
    },
    onTopBack() {
      // 返回上一个页面:从浏览历史栈弹出上一个URL并导航。
      // 历史栈为空时兜底为退出浏览器。
      const self = this;
      if (self.urlHistory && self.urlHistory.length > 0) {
        const prev = self.urlHistory.pop();
        console.warn('top-back: navigate to history=' + JSON.stringify(prev));
        if (self.browserLifecycle) {
          try { self.browserLifecycle.stop(); } catch (e) {}
        }
        setTimeout(function () {
          if (self.browserLifecycle && !self.browserLifecycle.state.leaving) {
            self.currentDisplayUrl = prev;
            self.browserLifecycle.restartForUrl(prev);
          }
        }, 600);
      } else {
        console.warn('top-back: history empty, exit frame');
        if (self.browserLifecycle) {
          self.browserLifecycle.leaveFrame('user exit');
        }
      }
    },
    onTopReload() {
      const cur = this.currentDisplayUrl || 'https://m.baidu.com/';
      if (this.browserLifecycle) {
        // 先停掉浏览器:点「刷新」的这次触摸同样会被 WPE raw touch 读到,
        // 不停掉会误触网页(跳到推荐页/热搜)。延迟足够长,等触摸抬起序列结束再重启。
        try { this.browserLifecycle.stop(); } catch (e) {}
        setTimeout(() => {
          if (!this.browserLifecycle.state.leaving) {
            this.browserLifecycle.restartForUrl(cur);
          }
        }, 900);
      }
    },
    openUrlKeyboard() {
      const cur = this.currentDisplayUrl || 'https://m.baidu.com/';
      const bridge = this.keyboardBridge;
      const session = bridge && bridge.state && bridge.state.session;
      if (!session) return;
      const initial = (cur === 'about:blank' || cur === 'about:start') ? '' : cur;
      // 先停掉浏览器:输入法确认瞬间的触摸不会再落到网页或浏览器内按键上(避免误触跳转/点到热搜)
      if (this.browserLifecycle) {
        try { this.browserLifecycle.stop(); } catch (e) {}
      }
      const uuid = session.open({
        text: initial,
        placeholder: '输入网址或搜索',
        inputType: 'EnUSPreferred',
        enterButtonText: '前往'
      });
      // 输入法没起来(空 uuid):不进入地址栏编辑态,立即把处理器还给 bridge 并恢复浏览器
      if (!uuid) {
        console.warn('address bar keyboard open failed (empty uuid)');
        if (bridge) bridge.restoreSessionHandlers();
        if (this.browserLifecycle) {
          setTimeout(() => {
            if (!this.browserLifecycle.state.leaving) this.browserLifecycle.restartForUrl(this.currentDisplayUrl);
          }, 400);
        }
        return;
      }
      const self = this;
      // 标记「正在编辑地址栏」,并记录地址栏文本,供「确认」按钮使用。
      // 这两个字段与网页输入完全隔离。
      self.addressBarEditing = true;
      self.addressBarText = initial;
      // 只处理「这一次」地址栏输入:输入结束后必须把处理器还给 KeyboardBridge,
      // 否则网页里点击输入框时的文本会被当成新网址(输入账号→跳百度搜索),
      // 并且网页的 web_input 请求会被 cancel 掉,账号永远填不进去。
      const restore = () => {
        const b = self.keyboardBridge;
        if (!b) return
        // 归还给 KeyboardBridge:网页发起的输入必须回写 response 文件,
        // 否则网页永远收不到文本(账号填不进去)。
        b.restoreSessionHandlers();
      };
      session.onConfirm = (newText) => {
        const val = (newText || '').trim();
        self.addressBarText = val;
        self.addressBarEditing = false;
        console.warn('keyboard onConfirm (address bar) text=' + JSON.stringify(val));
        restore();
        if (!val) {
          console.warn('address bar confirm empty -> restoring current url');
          if (self.browserLifecycle) {
            setTimeout(() => {
              if (!self.browserLifecycle.state.leaving) {
                self.browserLifecycle.restartForUrl(self.currentDisplayUrl);
              }
            }, 900);
          }
          return;
        }
        setTimeout(() => { self.navigateToUrl(val); }, 900);
      };
      session.onCancel = () => {
        self.addressBarEditing = false;
        restore();
        if (self.browserLifecycle) {
          setTimeout(() => {
            if (!self.browserLifecycle.state.leaving) self.browserLifecycle.restartForUrl(self.currentDisplayUrl);
          }, 900);
        }
      };
    },
    // 导航栏「确认」键:提交当前地址栏内容并跳转。
    // 不依赖输入法回调 —— 输入法确认无效时这是唯一可靠通路。
    onTopGo() {
      const self = this;
      const bridge = this.keyboardBridge;
      const session = bridge && bridge.state && bridge.state.session;
      const editing = self.addressBarEditing ? (self.addressBarText || '') : '';
      const target = (editing || self.currentDisplayUrl || '').trim();
      console.warn('top-go: editing=' + JSON.stringify(editing) +
        ' display=' + JSON.stringify(self.currentDisplayUrl) +
        ' target=' + JSON.stringify(target));
      if (!target || target === 'about:blank' || target === 'about:start') {
        console.warn('top-go: nothing to navigate');
        return;
      }
      // 先停掉浏览器:点「确认」的这次触摸会同时被 WPE 的 raw touch 读到,
      // 若不停掉,触摸会落到网页上(表现为跳到百度推荐页/热搜词条)。
      if (self.browserLifecycle) {
        try { self.browserLifecycle.stop(); } catch (e) {}
      }
      // 主动收起输入法,避免它继续盖住页面
      if (session && session.activeUuid && session.close) {
        try { session.close(); } catch (e) {}
      }
      // 地址栏编辑态随本次提交结束:清理编辑标记,
      // 并把输入法处理器归还 KeyboardBridge,防止残留地址栏处理器
      // 劫持之后的网页输入(输入账号→被当网址导航/跳百度搜索)。
      self.addressBarEditing = false;
      if (bridge) {
        try { bridge.restoreSessionHandlers(); } catch (e) {}
      }
      // 延迟要足够长:输入法收起 + 触摸抬起(UP)序列结束后再启动,
      // 否则新 WPE 会收到这次触摸的后续事件并误触页面。
      setTimeout(function () { self.navigateToUrl(target); }, 900);
    },

    // 统一的跳转入口:规整 URL + 重启浏览器到目标地址
    navigateToUrl(raw) {
      const self = this;
      let val = (raw || '').trim();
      if (!val) return;
      if (val === 'about:blank' || val === 'about:start') return;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(val)) {
        if (val.includes(' ') || !val.includes('.')) {
          val = (self.settingsSearch === 'bing')
            ? 'https://www.bing.com/search?q=' + encodeURIComponent(val)
            : 'https://m.baidu.com/s?word=' + encodeURIComponent(val);
        } else if (/^(\d{1,3}\.){3}\d{1,3}$/.test(val) || /^localhost/i.test(val)) {
          // IP地址或localhost默认用HTTP(校园网登录页/路由器管理页通常是HTTP)
          val = 'http://' + val;
        } else if (/(^|\.)(login|auth|wlan|portal|captive|sso|cas|wifi|wireless|net|drcom|radius|safe|network)\./i.test(val)
            || /\.(edu|gov|cn)(:|\/|$)/i.test(val) && /(login|auth|wlan|portal|sso|cas)/i.test(val)) {
          // 校园网/企业网登录页域名通常是HTTP,强制HTTPS会导致证书错误或连接失败
          val = 'http://' + val;
        } else {
          val = 'https://' + val;
        }
      }
      // 记录浏览历史:当前URL压入栈,供「返回」按钮使用
      const cur = self.currentDisplayUrl;
      if (cur && cur !== val && cur !== 'about:blank' && cur !== 'about:start') {
        self.urlHistory.push(cur);
        if (self.urlHistory.length > 50) self.urlHistory.shift();
        console.warn('navigate: history push=' + JSON.stringify(cur) + ' stack=' + self.urlHistory.length);
      }
      self.currentDisplayUrl = val;
      // B站视频页兼容性workaround:WPE WebKit(605.x)播放B站H5播放器报4004,
      // 自动转为嵌入播放器页面(player.bilibili.com),其播放器更简单兼容性更好。
      try {
        const bvMatch = val.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/);
        const epMatch = val.match(/bilibili\.com\/bangumi\/play\/(ep[0-9]+|ss[0-9]+)/);
        if (bvMatch) {
          const bvid = bvMatch[1];
          const pageMatch = val.match(/[?&]p=(\d+)/);
          const page = pageMatch ? pageMatch[1] : '1';
          val = 'https://player.bilibili.com/player.html?bvid=' + bvid
            + '&page=' + page + '&platform=html5&high_quality=0&danmaku=0&autoplay=0';
          self.currentDisplayUrl = val;
          console.warn('bilibili video redirected to embed player: ' + val);
        } else if (epMatch) {
          const epid = epMatch[1];
          val = 'https://player.bilibili.com/player.html?ep_id=' + epid
            + '&platform=html5&high_quality=0&danmaku=0&autoplay=0';
          self.currentDisplayUrl = val;
          console.warn('bilibili bangumi redirected to embed player: ' + val);
        }
      } catch (e) { console.warn('bilibili redirect failed: ' + e); }
      // 重启保护窗口:输入法收起会触发 onHide,期间绝不能停浏览器。
      // 不能只给固定 5s —— 输入法退场 + WPE 起来可能更久,
      // 一旦窗口过期 onHide 就会把刚起来的浏览器杀掉(就是「地址栏变了网页没变」)。
      self.urlRestartUntil = Date.now() + 20000;
      // 兜底:即使 onHide 抢先把浏览器停了,稍后再确认一次并补启动
      self.ensureBrowserAfterKeyboard();
      if (self.browserLifecycle) {
        try { self.browserLifecycle.restartForUrl(val); } catch (e) {
          console.warn('navigateToUrl failed: ' + e);
        }
      }
    },

    toggleNavBar() {
      this.navBarExpanded = !this.navBarExpanded;
    },

    onTopSettings() {
      this.showSettings = true;
      this.settingsHome = this.settingsHome || 'https://m.baidu.com/';
      // 面板悬浮于网页之上,若不先停浏览器,面板内按钮的触摸会穿透到
      // WPE raw touch,表现为点「设置」里按钮时网页被误触跳转。
      if (this.browserLifecycle) {
        try { this.browserLifecycle.stop(); } catch (e) {}
      }
    },
    // 「键盘」按钮:手动唤起输入法,作为网页输入框不唤起时的备选入口。
    // 初始文本为当前URL(与点击地址栏一致),确保导航栏「确认」按钮能拿到正确值。
    onTopKeyboard() {
      const self = this;
      const bridge = this.keyboardBridge;
      const session = bridge && bridge.state && bridge.state.session;
      if (!session) return;
      const initial = (self.currentDisplayUrl === 'about:blank' || self.currentDisplayUrl === 'about:start')
        ? '' : (self.currentDisplayUrl || '');
      if (self.browserLifecycle) {
        try { self.browserLifecycle.stop(); } catch (e) {}
      }
      const uuid = session.open({
        text: initial,
        placeholder: '输入网址或搜索词',
        inputType: 'EnUSPreferred',
        enterButtonText: '前往'
      });
      if (!uuid) {
        console.warn('top-keyboard: open failed (empty uuid)');
        if (bridge) bridge.restoreSessionHandlers();
        if (self.browserLifecycle) {
          setTimeout(() => {
            if (!self.browserLifecycle.state.leaving) self.browserLifecycle.restartForUrl(self.currentDisplayUrl);
          }, 400);
        }
        return;
      }
      self.addressBarEditing = true;
      self.addressBarText = initial;
      const restore = () => { if (bridge) bridge.restoreSessionHandlers(); };
      session.onConfirm = (newText) => {
        const val = (newText || '').trim();
        self.addressBarText = val;
        self.addressBarEditing = false;
        restore();
        if (!val) {
          if (self.browserLifecycle) {
            setTimeout(() => {
              if (!self.browserLifecycle.state.leaving) self.browserLifecycle.restartForUrl(self.currentDisplayUrl);
            }, 900);
          }
          return;
        }
        setTimeout(() => { self.navigateToUrl(val); }, 900);
      };
      session.onCancel = () => {
        self.addressBarEditing = false;
        restore();
        if (self.browserLifecycle) {
          setTimeout(() => {
            if (!self.browserLifecycle.state.leaving) self.browserLifecycle.restartForUrl(self.currentDisplayUrl);
          }, 900);
        }
      };
    },
    closeSettings() {
      this.showSettings = false;
      // 关闭面板后恢复浏览器:先停掉再重启,避免面板关闭瞬间的触摸
      // 被 WPE 读到误触网页。
      if (this.browserLifecycle && !this.browserLifecycle.state.leaving) {
        try {
          this.browserLifecycle.restartForUrl(this.currentDisplayUrl);
        } catch (e) {}
      }
    },
    setSettingsSearch(v) {
      this.settingsSearch = v;
    },
    setSettingsMode(m) {
      this.settingsMode = m;
      if (this.browserLifecycle) {
        try { this.browserLifecycle.restartForMode(m); } catch (e) {}
      }
      this.showSettings = false;
    },
    quitBrowser() {
      if (this.browserLifecycle) {
        this.browserLifecycle.leaveFrame('user exit');
      }
    },
    editSettingsHome() {
      const bridge = this.keyboardBridge;
      const session = bridge && bridge.state && bridge.state.session;
      if (!session) return;
      const self = this;
      if (self.browserLifecycle) {
        try { self.browserLifecycle.stop(); } catch (e) {}
      }
      const uuid = session.open({
        text: self.settingsHome || '',
        placeholder: '主页地址',
        inputType: 'EnUSPreferred',
        enterButtonText: '保存'
      });
      // 输入法没起来:不接管处理器,立即还给 bridge 并恢复浏览器
      if (!uuid) {
        console.warn('edit settings home: keyboard open failed (empty uuid)');
        if (bridge) bridge.restoreSessionHandlers();
        if (self.browserLifecycle) {
          setTimeout(() => {
            if (!self.browserLifecycle.state.leaving) self.browserLifecycle.restartForUrl(self.currentDisplayUrl);
          }, 400);
        }
        return;
      }
      // 本次「主页编辑」专用处理器,结束后必须还给 KeyboardBridge:
      // 否则之后网页里的输入框会继续触发「保存主页」逻辑,
      // 网页输入内容被当成新主页保存且网页永远收不到文本。
      const restore = () => {
        if (bridge) bridge.restoreSessionHandlers();
      };
      session.onConfirm = (t) => {
        const v = (t || '').trim();
        if (v) {
          self.settingsHome = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : ('https://' + v);
        }
        restore();
        if (self.browserLifecycle) {
          setTimeout(() => {
            if (!self.browserLifecycle.state.leaving) self.browserLifecycle.restartForUrl(self.currentDisplayUrl);
          }, 400);
        }
      };
      session.onCancel = () => {
        restore();
        if (self.browserLifecycle) {
          setTimeout(() => {
            if (!self.browserLifecycle.state.leaving) self.browserLifecycle.restartForUrl(self.currentDisplayUrl);
          }, 400);
        }
      };
    },
    setHomeToCurrent() {
      this.settingsHome = this.currentDisplayUrl || 'https://m.baidu.com/';
    },
    onKeyboardTextareaInput(value) {
      this.ensureControllers();
      this.keyboardBridge.onTextareaInput(value);
    },
    onKeyboardTextareaConfirm(value) {
      this.ensureControllers();
      this.keyboardBridge.onTextareaConfirm(value);
    },
    onKeyboardTextareaFinished(value) {
      this.ensureControllers();
      this.keyboardBridge.onTextareaFinished(value);
    },
    onKeyboardTextareaFocus() {
      this.ensureControllers();
      this.keyboardBridge.onTextareaFocus();
    },
    onKeyboardTextareaBlur() {
      this.ensureControllers();
      this.keyboardBridge.onTextareaBlur();
    },
    clearKeyboardHideTimer() {
      if (!this.keyboardHideTimer) return
      clearTimeout(this.keyboardHideTimer);
      this.keyboardHideTimer = null;
    },
    onKeyboardBridgeInactive() {
      this.clearKeyboardHideTimer();
      this.keyboardHideTimer = setTimeout(() => {
        this.keyboardHideTimer = null;
        if (this.pageVisible || this.keyboardBridge.isActive()) return
        console.warn('wpe hidden after keyboard closed; stopping browser');
        this.browserLifecycle.stop();
      }, 15000);
    },
    onShow() {
      this.ensureControllers();
      this.pageVisible = true;
      this.clearKeyboardHideTimer();
      this.keyboardBridge.onPageShow();
      this.keyboardBridge.reconcileActiveRequest();
      if (!this.browser.leaving) {
        this.browserLifecycle.start();
      }
    },
    onHide() {
      console.warn('wpe frame onHide');
      this.ensureControllers();
      // 输入法激活中:不能停浏览器,也不能标记为「页面已隐藏」
      // (否则后面的恢复逻辑会以为用户离开了而不再补启动)
      if (this.keyboardBridge.onPageHide()) {
        console.warn('wpe frame onHide ignored while keyboard active');
        this.ensureBrowserAfterKeyboard();
        return
      }
      this.pageVisible = false;
      // 正在按新地址重启:onHide 是输入法收起触发的,此时停掉会把刚落起来的
      // 浏览器直接杀掉,表现就是「地址栏变了但网页没变」。这里必须放行。
      if (this.urlRestartUntil && Date.now() < this.urlRestartUntil) {
        console.warn('wpe frame onHide ignored during url restart ('
          + Math.round((this.urlRestartUntil - Date.now()) / 1000) + 's left)');
        return
      }
      this.browserLifecycle.stop();
    },

    /**
     * 输入法退场会触发一次 onHide,但它并不代表用户离开了页面。
     * 若紧接着(若干秒内)页面又回到前台,这里补一次启动,
     * 避免「地址栏已经变了、网页却停在旧页面/空白」。
     */
    ensureBrowserAfterKeyboard() {
      const self = this;
      self.setTimeout_ && self.setTimeout_('post-kbd-resume', function () {
        if (self.browser.leaving) return
        let running = false;
        try {
          running = !!(browserPlayer.isBrowserRunning &&
            browserPlayer.isBrowserRunning({ workdir: self.browserLifecycle.workdir() }));
        } catch (e) { running = false; }
        if (!running) {
          console.warn('post-keyboard resume: browser not running, restarting');
          self.browserLifecycle.start();
        } else {
          console.warn('post-keyboard resume: browser healthy');
        }
      }, 800);
    },
    onUnload() {
      console.warn('wpe frame onUnload');
      this.ensureControllers();
      this.pageVisible = false;
      this.clearKeyboardHideTimer();
      this.teardownControllers();
    },
  },
};

var style_0 = { "_": {
  "frame-page": {
    "width": "100vw",
    "height": "100vh",
    "backgroundColor": "#000000"
  },
  "browser-hole": {
    "width": "100vw",
    "height": "100vh"
  },
  "top-tab-bar": {
    "position": "absolute",
    "bottom": "0",
    "left": "0",
    "width": "100vw",
    "height": "42px",
    "flexDirection": "row",
    "alignItems": "center",
    "backgroundColor": "rgba(21, 27, 34, 0.96)",
    "zIndex": 999,
    "paddingLeft": "8px",
    "paddingRight": "8px"
  },
  "top-tab-back": {
    "width": "64px",
    "height": "34px",
    "lineHeight": "34px",
    "textAlign": "center",
    "fontSize": "15px",
    "color": "#ffffff",
    "backgroundColor": "#26323d",
    "borderRadius": "7px",
    "marginRight": "8px"
  },
  "top-tab-url": {
    "flex": 1,
    "maxWidth": "340px",
    "height": "34px",
    "lineHeight": "34px",
    "backgroundColor": "#0d1117",
    "borderRadius": "7px",
    "paddingLeft": "10px",
    "paddingRight": "10px",
    "fontSize": "14px",
    "color": "#8fd0ff",
    "overflow": "hidden",
    "textOverflow": "ellipsis",
    "whiteSpace": "nowrap"
  },
  "top-tab-reload": {
    "width": "64px",
    "height": "34px",
    "lineHeight": "34px",
    "textAlign": "center",
    "fontSize": "15px",
    "color": "#ffffff",
    "backgroundColor": "#26323d",
    "borderRadius": "7px",
    "marginLeft": "8px"
  },
  "top-tab-settings": {
    "width": "64px",
    "height": "34px",
    "lineHeight": "34px",
    "textAlign": "center",
    "fontSize": "15px",
    "color": "#ffffff",
    "backgroundColor": "#2d6a4f",
    "borderRadius": "7px",
    "marginLeft": "8px"
  },
  "top-tab-keyboard": {
    "width": "64px",
    "height": "34px",
    "lineHeight": "34px",
    "textAlign": "center",
    "fontSize": "15px",
    "color": "#ffffff",
    "backgroundColor": "#7b2d8c",
    "borderRadius": "7px",
    "marginLeft": "8px"
  },
  "top-tab-go": {
    "width": "64px",
    "height": "34px",
    "lineHeight": "34px",
    "textAlign": "center",
    "fontSize": "15px",
    "color": "#ffffff",
    "backgroundColor": "#1d5c96",
    "borderRadius": "7px",
    "marginLeft": "8px"
  },
  "nav-toggle-btn": {
    "position": "absolute",
    "bottom": "50px",
    "right": "8px",
    "width": "64px",
    "height": "32px",
    "lineHeight": "32px",
    "textAlign": "center",
    "fontSize": "14px",
    "color": "#ffffff",
    "backgroundColor": "rgba(21, 27, 34, 0.85)",
    "borderRadius": "7px",
    "zIndex": 1001
  },
  "settings-panel": {
    "position": "absolute",
    "bottom": "42px",
    "left": "140px",
    "width": "680px",
    "backgroundColor": "#1c2430",
    "borderRadius": "12px",
    "zIndex": 1000,
    "paddingTop": "10px",
    "paddingRight": "10px",
    "paddingBottom": "10px",
    "paddingLeft": "10px"
  },
  "settings-title": {
    "fontSize": "18px",
    "color": "#ffffff",
    "lineHeight": "24px",
    "marginBottom": "4px"
  },
  "settings-row": {
    "flexDirection": "row",
    "alignItems": "center",
    "height": "30px",
    "marginTop": "2px"
  },
  "settings-label": {
    "fontSize": "15px",
    "color": "#c9d4df",
    "width": "180px"
  },
  "settings-value": {
    "flex": 1,
    "fontSize": "15px",
    "color": "#8fd0ff"
  },
  "settings-btn": {
    "width": "110px",
    "height": "28px",
    "lineHeight": "28px",
    "textAlign": "center",
    "fontSize": "14px",
    "color": "#ffffff",
    "backgroundColor": "#33506b",
    "borderRadius": "7px",
    "marginLeft": "8px"
  },
  "settings-btn-active": {
    "backgroundColor": "#2d6a4f"
  },
  "settings-btn-danger": {
    "backgroundColor": "#8a3d3d"
  },
  "keyboard-bridge-textarea": {
    "position": "absolute",
    "left": 0,
    "top": 0,
    "width": "2px",
    "height": "2px",
    "opacity": 0.01,
    "color": "rgba(0,0,0,0)",
    "backgroundColor": "rgba(0,0,0,0)",
    "fontSize": "1px"
  }
} };

var render = function (){
var _vm=this;var _h=_vm.$createElement;var _c=_vm._self._c||_h;
  return _c('div', {
    staticClass: ["frame-page"]
  }, [_c('hole', {
    ref: "browserHole",
    staticClass: ["browser-hole"]
  }), (_vm.navBarExpanded) ? _c('div', {
    staticClass: ["top-tab-bar"]
  }, [
    _c('text', {
      staticClass: ["top-tab-back"],
      on: { "click": function($event) { return _vm.onTopBack() } }
    }, [_vm._v("返回")]),
    _c('text', {
      staticClass: ["top-tab-url"],
      on: { "click": function($event) { return _vm.openUrlKeyboard() } }
    }, [_vm._v(_vm._s(_vm.currentDisplayUrl || "输入网址或搜索"))]),
    _c('text', {
      staticClass: ["top-tab-reload"],
      on: { "click": function($event) { return _vm.onTopReload() } }
    }, [_vm._v("刷新")]),
    _c('text', {
      staticClass: ["top-tab-settings"],
      on: { "click": function($event) { return _vm.onTopSettings() } }
    }, [_vm._v("设置")]),
    // 「键盘」按钮:手动唤起输入法。网页输入框键盘不唤起时的备选入口,
    // 点击后弹出输入法,输入内容作为URL或搜索词提交。
    _c('text', {
      staticClass: ["top-tab-keyboard"],
      on: { "click": function($event) { return _vm.onTopKeyboard() } }
    }, [_vm._v("键盘")]),
    // 导航栏最右侧:确认键。点击后直接提交当前地址栏内容,
    // 不依赖输入法的确认回调(固件确认回调不触发时的可靠通路)。
    _c('text', {
      staticClass: ["top-tab-go"],
      on: { "click": function($event) { return _vm.onTopGo() } }
    }, [_vm._v("确认")])
  ]) : _vm._e(), _c('text', {
    staticClass: ["nav-toggle-btn"],
    on: { "click": function($event) { return _vm.toggleNavBar() } }
  }, [_vm._v(_vm.navBarExpanded ? "收起" : "菜单")]), (_vm.showSettings) ? _c('div', {
    staticClass: ["settings-panel"]
  }, [
    _c('text', {
      staticClass: ["settings-title"]
    }, [_vm._v("浏览器设置")]),
    _c('div', {
      staticClass: ["settings-row"]
    }, [
      _c('text', { staticClass: ["settings-label"] }, [_vm._v("主页")]),
      _c('text', { staticClass: ["settings-value"] }, [_vm._v(_vm._s(_vm.settingsHome))]),
      _c('text', { staticClass: ["settings-btn"], on: { "click": function($event) { return _vm.editSettingsHome() } } }, [_vm._v("修改")]),
      _c('text', { staticClass: ["settings-btn"], on: { "click": function($event) { return _vm.setHomeToCurrent() } } }, [_vm._v("设为当前页")])
    ]),
    _c('div', {
      staticClass: ["settings-row"]
    }, [
      _c('text', { staticClass: ["settings-label"] }, [_vm._v("搜索引擎")]),
      _c('text', {
        class: _vm.settingsSearch === 'baidu' ? 'settings-btn settings-btn-active' : 'settings-btn',
        on: { "click": function($event) { return _vm.setSettingsSearch('baidu') } }
      }, [_vm._v("百度")]),
      _c('text', {
        class: _vm.settingsSearch === 'bing' ? 'settings-btn settings-btn-active' : 'settings-btn',
        on: { "click": function($event) { return _vm.setSettingsSearch('bing') } }
      }, [_vm._v("必应")])
    ]),
    _c('div', {
      staticClass: ["settings-row"]
    }, [
      _c('text', { staticClass: ["settings-label"] }, [_vm._v("显示模式")]),
      _c('text', {
        class: _vm.settingsMode === 'last' ? 'settings-btn settings-btn-active' : 'settings-btn',
        on: { "click": function($event) { return _vm.setSettingsMode('last') } }
      }, [_vm._v("沿用")]),
      _c('text', {
        class: _vm.settingsMode === 'native' ? 'settings-btn settings-btn-active' : 'settings-btn',
        on: { "click": function($event) { return _vm.setSettingsMode('native') } }
      }, [_vm._v("原生")]),
      _c('text', {
        class: _vm.settingsMode === 'rotate90' ? 'settings-btn settings-btn-active' : 'settings-btn',
        on: { "click": function($event) { return _vm.setSettingsMode('rotate90') } }
      }, [_vm._v("90°")]),
      _c('text', {
        class: _vm.settingsMode === 'rotate180' ? 'settings-btn settings-btn-active' : 'settings-btn',
        on: { "click": function($event) { return _vm.setSettingsMode('rotate180') } }
      }, [_vm._v("180°")]),
      _c('text', {
        class: _vm.settingsMode === 'rotate270' ? 'settings-btn settings-btn-active' : 'settings-btn',
        on: { "click": function($event) { return _vm.setSettingsMode('rotate270') } }
      }, [_vm._v("270°")])
    ]),
    _c('div', {
      staticClass: ["settings-row"]
    }, [
      _c('text', {
        staticClass: ["settings-btn"],
        on: { "click": function($event) { return _vm.closeSettings() } }
      }, [_vm._v("关闭")]),
      _c('text', {
        staticClass: ["settings-btn", "settings-btn-danger"],
        on: { "click": function($event) { return _vm.quitBrowser() } }
      }, [_vm._v("退出浏览器")])
    ])
  ]) : _vm._e(), (_vm.keyboard.textareaVisible) ? _c('textarea', {
    ref: "keyboardTextarea",
    staticClass: ["keyboard-bridge-textarea"],
    attrs: {
      "value": _vm.keyboard.textareaValue,
      "focus": _vm.keyboard.textareaFocused,
      "maxlength": _vm.keyboard.textareaMaxlength,
      "inputType": _vm.keyboard.textareaInputType,
      "showCursor": true,
      "softInputEnable": true,
      "placeholder": "请输入内容",
      "placeholderColor": "#878A99",
      "cursorColor": "#008CFF",
      "cursorSize": 3
    },
    on: {
      "input": _vm.onKeyboardTextareaInput,
      "confirm": _vm.onKeyboardTextareaConfirm,
      "textChanged": _vm.onKeyboardTextareaInput,
      "textEditFinished": _vm.onKeyboardTextareaFinished,
      "focus": _vm.onKeyboardTextareaFocus,
      "blur": _vm.onKeyboardTextareaBlur
    }
  }) : _vm._e()], 1)
};

var staticRenderFns=[];
render._withStripped = true;
  
const __file = 'src/pages/frame/frame.vue';
const _scopeId = 'data-v-4b3d3df7';

const _exports = script;

_exports.render = render;
_exports.staticRenderFns = staticRenderFns;
_exports._compiled = true;
_exports._scopeId = _scopeId;
_exports.themes = {};
_exports.style = Object.assign({}, style_0['_']);
_exports.__file = __file;

var FrameComponent = _exports;

class PageFrame extends BasePage {
  onLoad(options) {
    super.onLoad(options);
    this.setRootComponent(FrameComponent);
  }
}

export { PageFrame as default };
