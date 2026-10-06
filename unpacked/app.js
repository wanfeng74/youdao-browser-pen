import { B as BasePage } from './base-page-bd62aef9.js';

class App extends $falcon.App {
  /**
   * 构造函数,应用生命周期内只构造一次
   */
  constructor() {
    super();
  }

  /**
   * 应用生命周期:应用启动. 初始化完成时回调,全局只触发一次.
   * @param {Object} options 启动参数
   */
  onLaunch(options) {
    super.onLaunch(options);
    // 屏幕分辨率适配机制:
    // 当 viewPort 设置750时, 所有元素尺寸可按照设计稿为 750px 宽度标准编写,
    // 最后系统会动态计算屏幕实际尺寸并显示.
    // this.setViewPort(750)

    // 设置页面基类,应用全局的$falcon.Page将被替换成此处指定的BasePage.
    // 继承自$falcon.Page的页面将继承自改基类.
    // 如页面未指定js,直接指向.vue文件,页面创建时会默认创建该类的实例
    $falcon.useDefaultBasePageClass(BasePage);
  }

  /**
   * 应用生命周期:应用销毁前触发
   */
  onDestroy() {
    super.onDestroy();
  }
}

try {
  globalThis['window'] = {
    requestAnimationFrame,
    cancelAnimationFrame
  };
} catch (err) {
  console.log(err);
}

try {
  globalThis['process'] = {
    env: {
      NODE_ENV: 'production'
    }
  };
} catch (err) {
  console.log(err);
}

var App$1 = App;

App$1.meta = {
  "pages": {
    "index": "pages/index/index.js",
    "frame": "pages/frame/frame.js"
  },
  "props": {
    "browser_display_sku": {
      "default": {
        "panelSize": "960x266",
        "drmMode": "480x960",
        "rotation": 270
      }
    },
    "keyboard_backend": "auto"
  }
};
App$1.meta.name = 'wpe4ydpv2';
App$1.meta.version = '1.0.0';
App$1.meta.isSingleJsBundle = false;
$falcon.__AppClazz = App$1;
$falcon.__loadModuleDefault = async function (fileName) {
  if(App$1.__pages && App$1.__pages[fileName]){
    return App$1.__pages[fileName];
  } else {
    try{
      const pagePath = './' + fileName + '.js';
      let mod = await import(pagePath);
      return mod.default;
    } catch(e){
      console.log(e.message, e.stack);
    }
  }
};
