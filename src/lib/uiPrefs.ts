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

/** 给设置页预览卡片用 */
export const FONT_STACKS = FONTS;

/** 字体选项（设置页/写作页共用）：key → 中文名 */
export const FONT_OPTIONS: [string, string][] = [
  ["serif", "宋体"],
  ["sans", "黑体"],
  ["kai", "楷体"],
];

/** 写作页快捷调整：写设置 + 立即改 CSS 变量（与设置页同一份键，双向同步） */
export async function setEditorFont(key: string) {
  await api.setSetting("editor_font", key);
  document.documentElement.style.setProperty(
    "--editor-font",
    FONTS[key] ?? FONTS.serif
  );
}

export async function setEditorFontSize(px: number) {
  await api.setSetting("editor_font_size", String(px));
  document.documentElement.style.setProperty("--editor-font-size", `${px}px`);
}

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
