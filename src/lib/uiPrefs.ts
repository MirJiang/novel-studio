import { api } from "./api";

/**
 * UI 偏好：主题 / 编辑器字体字号，存 settings 表，启动与保存时应用。
 * 主题通过 <html data-theme> 切换 index.css 里的令牌组；
 * 字体通过 --editor-font / --editor-font-size CSS 变量驱动 .tiptap。
 */

const FONTS: Record<string, string> = {
  serif:
    '"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", "STSong", "SimSun", serif',
  sans: '"SF Pro Display", "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif',
  kai: '"Kaiti SC", "KaiTi", "STKaiti", "DFKai-SB", serif',
};

let mediaHooked = false;

export async function applyUiPrefs() {
  const theme = (await api.getSetting("ui_theme")) ?? "light";
  applyTheme(theme);

  if (!mediaHooked) {
    mediaHooked = true;
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        void api.getSetting("ui_theme").then((t) => applyTheme(t ?? "light"));
      });
  }

  const font = (await api.getSetting("editor_font")) ?? "serif";
  const size = (await api.getSetting("editor_font_size")) ?? "17";
  document.documentElement.style.setProperty(
    "--editor-font",
    FONTS[font] ?? FONTS.serif
  );
  document.documentElement.style.setProperty("--editor-font-size", `${size}px`);
}

function applyTheme(theme: string) {
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}
