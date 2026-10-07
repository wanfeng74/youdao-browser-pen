# 有道词典笔 Web 浏览器

为网易有道词典笔（Falcon MiniApp 平台）定制的 Web 浏览器应用。

## 功能特性

- **完整网页浏览**：基于 WPE WebKit 内核，支持 HTML5、CSS3、JavaScript
- **横屏自适应**：960×480 横屏显示，270° 旋转输出，适配词典笔物理屏幕
- **地址栏导航**：支持 URL 输入、搜索词自动跳转、历史记录返回
- **触摸交互**：原生触摸滚动、点击、缩放
- **视频播放**：硬件解码 + DRM overlay 直出，支持 B 站等视频网站
- **低内存优化**：针对 400MB 内存设备优化，Skia CPU 光栅化，30fps 刷新节流

## 设备要求

- 有道词典笔（Falcon MiniApp 运行时）
- 屏幕：480×960 物理竖屏，逻辑横屏 960×480
- 内存：≥400MB
- ABI：ARM aarch64

## 安装方法

1. 下载最新版本的 `.amr` 安装包（见 Releases）
2. 通过 ADB 推送到设备：
   ```bash
   adb push 8002482420830506.1_4_XX.amr /tmp/
   ```
3. 安装：
   ```bash
   adb shell miniapp_cli install /tmp/8002482420830506.1_4_XX.amr
   ```
4. 启动：
   ```bash
   adb shell miniapp_cli start 8002482420830506 --index
   ```

## 版本历史

### v1.4.25
- 回滚到 v1.4.20 稳定基线
- 删除地址栏键盘按钮
- WPE_DRM_MODE 强制横屏，修复间歇性"侧边一条"显示异常
- watchdog 连续 3 次失败才判定崩溃，修复"黑屏→百度→黑屏"循环

### v1.4.20
- WPE_DRM_MODE 强制横屏修复间歇性侧边一条
- 恢复原始 GAME_HOSTS

### v1.4.19
- watchdog 连续3次失败才判定崩溃
- 启动延迟恢复 120ms

### v1.4.18
- 去掉启动页文字
- 键盘按钮初始值修复

### v1.4.14
- WPE_DRM_MODE 恢复横屏（修复硬编码竖屏导致的侧边一条）
- cert JSON 对象格式修复（解决 install failed: 2）

### v1.4.13
- cert 格式修复为 JSON 对象 `{"size":N,"md5":"xxx"}`

### v1.4.0
- 原始版本

## 已知问题

- B 站全屏播放后控制条可能丢失（hole-punch overlay 内核行为，MiniApp 侧无法修复）
- 部分网站非标准对话框可能不支持键盘唤起
- 内存占用较高时可能触发页面重载

## 项目结构

```
unpacked/
├── manifest.json          # 应用清单（版本、cert 校验）
├── app.js                 # 应用入口
├── index.js               # 启动页（自动跳转浏览器）
├── frame.js               # 主页面（地址栏、浏览器生命周期、键盘桥）
├── base-page-*.js         # 基础页面类
├── display-resolver-*.js  # 显示配置解析（屏幕尺寸、旋转、DRM 模式）
├── app_icon.png           # 应用图标
├── icon.png               # 图标
├── assets/
│   └── wpe-runtime/       # WPE WebKit 运行时
│       ├── run.sh         # WPE 启动脚本（环境变量、触摸、滚动、内存配置）
│       ├── wpe-drm-minimal # WPE 二进制（ARM aarch64）
│       ├── lib/           # 运行时库
│       └── ...
└── libs/                  # 原生库
```

## 开发说明

### 打包

```bash
cd unpacked
zip -qrD ../8002482420830506.1_4_XX.amr .
```

### cert 校验

打包前必须重算 `manifest.json` 中的 cert 字段，格式为 JSON 对象：
```json
"cert": {
  "frame.js": {"size": 12345, "md5": "abcdef..."},
  ...
}
```

### 关键配置（run.sh）

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `WPE_PANEL_SIZE` | 960x480 | 逻辑横屏尺寸 |
| `WPE_DRM_MODE` | $WPE_PANEL_SIZE | DRM 输出模式（必须横屏） |
| `WPE_PANEL_ROTATION` | 270 | 输出旋转角度 |
| `WPE_SEND_TOUCH_EVENTS` | 1 | 原生触摸事件（1=原生，0=指针合成） |
| `WPE_TOUCH_NATIVE_SCROLL` | 1 | 原生滚动 |
| `WPE_WEB_PROCESS_MEMORY_LIMIT_MB` | 550 | Web 进程内存限制 |

## License

MIT
