//! 发布到番茄作家后台：独立 webview 窗口 + eval 注入填充（fill-only 半自动）
//!
//! 参考社区开源方案（hchcx/fanqie_auto_publish、rockbenben/fanqie-publisher、
//! amm10090/fanqie-publisher-skill）：番茄作家后台无公开 API，只能驱动页面。
//! 我们用 Tauri 第二窗口代替 Playwright——用户扫码登录（cookie 持久化在独立
//! 数据目录），程序只负责把章节填进编辑页，**发布按钮永远人工点**（fill-only，
//! 把账号风险留给用户自己确认）。
//!
//! ★ 番茄后台改版先改这里：FILL_SCRIPT 里的选择器候选表。

use crate::db::{self, Db};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

// 番茄作家后台在主域路径下（writer.fanqienovel.com 子域并不存在）；
// 地址参照 fanqie_auto_publish / fanqie-publisher 两个开源实现
const FANQIE_HOME: &str = "https://fanqienovel.com/main/writer/?enter_from=author_zone";
const WIN_LABEL: &str = "fanqie-pub";

/// 打开（或聚焦）番茄作家后台窗口。
/// 首次使用需扫码登录，WebView2 会持久化 cookie（免登）。
#[tauri::command]
pub async fn open_fanqie_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(WIN_LABEL) {
        let _ = w.unminimize();
        w.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(
        &app,
        WIN_LABEL,
        WebviewUrl::External(FANQIE_HOME.parse().map_err(|e| format!("{e}"))?),
    )
    .title("番茄作家后台 · Novel Studio 发布助手")
    .inner_size(1100.0, 800.0)
    .build()
    .map_err(|e| format!("创建发布窗口失败: {e}"))?;

    // WebView2 第二窗口在 Windows 上偶发黑屏（控制器 bounds 没同步），轻微 resize 强制重排
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    if let Ok(sz) = win.inner_size() {
        let _ = win.set_size(tauri::PhysicalSize::new(sz.width + 1, sz.height));
        let _ = win.set_size(tauri::PhysicalSize::new(sz.width, sz.height));
    }
    let _ = win.set_focus();
    Ok(())
}

/// 填充脚本：把章节标题/正文填进番茄的章节编辑页。
/// 结果通过 location.hash 回传（eval 无返回值、wry 不会把 document.title 同步到
/// 原生窗口标题，URL fragment 是最轻的回读通道且不触发页面导航），
/// Rust 侧稍等后读 w.url() 解析；脚本 2.5 秒后清掉 hash。
const FILL_SCRIPT: &str = r#"(function(){
  var R = {ok:false, message:""};
  function done(){
    try {
      var u = new URL(location.href);
      u.hash = "nsfill=" + encodeURIComponent(JSON.stringify(R));
      history.replaceState(null, "", u.toString());
      setTimeout(function(){
        history.replaceState(null, "", location.pathname + location.search);
      }, 2500);
    } catch(e){}
  }
  try {
    if (!location.host.includes("fanqienovel.com")) {
      R.message = "当前窗口不在番茄作家后台"; return done();
    }
    // ---- 选择器候选表（后台改版先改这里）----
    var titleEl = document.querySelector(
      'input[placeholder*="标题"], input[placeholder*="章节名"], input[placeholder*="章节"], .chapter-title input'
    );
    var bodyEl = document.querySelector(
      '.ProseMirror[contenteditable="true"], [contenteditable="true"].editor, [contenteditable="true"]'
    );
    // --------------------------------------
    if (!titleEl || !bodyEl) {
      R.message = "没找到标题/正文输入框：请先在后台进入作品的「新建章节」编辑页";
      return done();
    }
    // React 受控 input：要走原生 setter + input 事件才会被框架接收
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(titleEl, __TITLE__);
    titleEl.dispatchEvent(new Event("input", {bubbles:true}));
    titleEl.dispatchEvent(new Event("change", {bubbles:true}));
    // 正文：按段落转成 <p> 注入富文本编辑器
    bodyEl.focus();
    var esc = function(s){ return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); };
    var html = __CONTENT__.split(/\n+/).filter(function(l){return l.trim();})
      .map(function(l){ return "<p>"+esc(l)+"</p>"; }).join("");
    bodyEl.innerHTML = html;
    bodyEl.dispatchEvent(new Event("input", {bubbles:true}));
    R.ok = true;
    R.message = "已填充，请到后台窗口核对后手动发布";
    done();
  } catch (e) {
    R.message = "填充异常: " + e.message;
    done();
  }
})();"#;

/// 极简 percent-decode（与前端 encodeURIComponent 对应）
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 把指定章节填充到番茄后台当前打开的章节编辑页（只填不发布）
///
/// 必须是 async：同步命令跑在主线程上，里面的 sleep 会冻结事件循环，
/// eval 的脚本反而永远得不到执行（命令卡死、前端一直"填充中"）。
#[tauri::command]
pub async fn fill_chapter_draft(
    app: AppHandle,
    db: State<'_, Db>,
    chapter_id: i64,
) -> Result<String, String> {
    let (title, text) = {
        let chapter = db.get_chapter(chapter_id).map_err(|e| e.to_string())?;
        let text = db::html_to_text(&chapter.content);
        (chapter.title, text)
    };
    if text.trim().is_empty() {
        return Err("该章节还没有内容".to_string());
    }
    let w = app
        .get_webview_window(WIN_LABEL)
        .ok_or("发布窗口未打开，请先点「打开番茄作家后台」")?;

    let script = FILL_SCRIPT
        .replace("__TITLE__", &serde_json::to_string(&title).unwrap())
        .replace("__CONTENT__", &serde_json::to_string(&text).unwrap());
    w.eval(&script).map_err(|e| format!("注入脚本失败: {e}"))?;

    // eval 无返回值：脚本把结果写进 location.hash，稍等后回读
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    let url_str = w.url().map(|u| u.to_string()).unwrap_or_default();
    if let Some(pos) = url_str.find("#nsfill=") {
        let decoded = percent_decode(&url_str[pos + 8..]);
        let v: serde_json::Value =
            serde_json::from_str(&decoded).map_err(|e| format!("解析填充结果失败: {e}"))?;
        let message = v["message"].as_str().unwrap_or("未知结果").to_string();
        if v["ok"].as_bool() == Some(true) {
            Ok(message)
        } else {
            Err(message)
        }
    } else {
        // 没读到回传（页面在导航/脚本被拦），不当作硬失败
        Ok("填充指令已发送，请查看后台窗口确认".to_string())
    }
}
