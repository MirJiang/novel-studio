import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { applyUiPrefs, FONT_STACKS } from "../lib/uiPrefs";

interface FieldDef {
  key: string;
  label: string;
  placeholder: string;
  secret: boolean;
  /** 有 options 时渲染下拉框而不是输入框 */
  options?: { value: string; label: string }[];
}

/** 厂商预设：选中后把 fills 合入表单（空值/缺省不覆盖），保存前可再改 */
type VendorPreset = { name: string; fills: Record<string, string> };

interface SectionDef {
  id: string;
  label: string;
  title: string;
  hint: string;
  fields: FieldDef[];
  presets?: VendorPreset[];
}

/** 文本模型厂商预设：选中后自动填接口地址/协议/推荐模型，保存前可再改 */
const LLM_PRESETS: VendorPreset[] = [
  {
    name: "DeepSeek",
    fills: {
      llm_base_url: "https://api.deepseek.com/v1",
      llm_protocol: "openai",
      llm_model: "deepseek-chat",
    },
  },
  {
    name: "OpenAI",
    fills: {
      llm_base_url: "https://api.openai.com/v1",
      llm_protocol: "openai",
      llm_model: "gpt-4o-mini",
    },
  },
  {
    name: "Claude（Anthropic）",
    fills: {
      llm_base_url: "https://api.anthropic.com",
      llm_protocol: "anthropic",
      llm_model: "claude-sonnet-4-5",
    },
  },
  {
    name: "通义千问（阿里云兼容模式）",
    fills: {
      llm_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      llm_protocol: "openai",
      llm_model: "qwen-plus",
    },
  },
  {
    name: "Kimi（月之暗面）",
    fills: {
      llm_base_url: "https://api.moonshot.cn/v1",
      llm_protocol: "openai",
      llm_model: "kimi-k2-0711-preview",
    },
  },
  {
    name: "智谱 GLM",
    fills: {
      llm_base_url: "https://open.bigmodel.cn/api/paas/v4",
      llm_protocol: "openai",
      llm_model: "glm-4-plus",
    },
  },
  {
    name: "OpenRouter",
    fills: {
      llm_base_url: "https://openrouter.ai/api/v1",
      llm_protocol: "openai",
    },
  },
];

/** 生图厂商预设（OpenAI Images 协议；aliyuncs.com 域名后端自动切原生协议） */
const IMG_PRESETS: VendorPreset[] = [
  {
    name: "火山方舟 Seedream（即梦）",
    fills: {
      img_base_url: "https://ark.cn-beijing.volces.com/api/v3",
      img_model: "doubao-seedream-4-0-250828",
    },
  },
  {
    name: "阿里云百炼（万相）",
    fills: {
      img_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      img_model: "wan2.7-image",
    },
  },
  {
    name: "OpenAI",
    fills: {
      img_base_url: "https://api.openai.com/v1",
      img_model: "gpt-image-1",
    },
  },
  {
    name: "硅基流动 SiliconFlow",
    fills: {
      img_base_url: "https://api.siliconflow.cn/v1",
      img_model: "Kwai-Kolors/Kolors",
    },
  },
];

/** 图生视频厂商预设（火山方舟 Seedance 异步任务协议） */
const VIDEO_PRESETS: VendorPreset[] = [
  {
    name: "火山方舟 Seedance",
    fills: {
      video_base_url: "https://ark.cn-beijing.volces.com/api/v3",
      video_model: "doubao-seedance-1-0-pro-250528",
    },
  },
];

const SECTIONS: SectionDef[] = [
  {
    id: "llm",
    label: "文本模型",
    title: "文本模型",
    hint: "续写 / 改写 / 摘要 / 起书策划 / 视频口播稿共用。协议只有两套：OpenAI 兼容（DeepSeek / 通义 / Kimi / 智谱 / OpenAI / OpenRouter / one-api…）与 Claude（Anthropic），自定义中转填地址即可",
    presets: LLM_PRESETS,
    fields: [
      {
        key: "llm_protocol",
        label: "协议",
        placeholder: "",
        secret: false,
        options: [
          { value: "", label: "自动（按接口地址识别）" },
          { value: "openai", label: "OpenAI 兼容" },
          { value: "anthropic", label: "Claude / Anthropic" },
        ],
      },
      {
        key: "llm_base_url",
        label: "接口地址",
        placeholder: "https://api.deepseek.com/v1",
        secret: false,
      },
      { key: "llm_api_key", label: "API Key", placeholder: "sk-…", secret: true },
      {
        key: "llm_model",
        label: "模型",
        placeholder: "deepseek-chat",
        secret: false,
      },
      {
        key: "batch_checkpoint_interval",
        label: "批量写章自检断点（每 N 章暂停巡检，0=关闭）",
        placeholder: "0",
        secret: false,
      },
    ],
  },
  {
    id: "img",
    label: "封面生图",
    title: "封面生图",
    hint: "封面、设定图、视频分镜配图共用这组配置。兼容 OpenAI Images 协议；阿里云百炼/Token 套餐（aliyuncs.com 域名）自动走原生协议（如 wan2.7-image）。选预设自动填，接口地址可手改成任意中转/自部署服务",
    presets: IMG_PRESETS,
    fields: [
      {
        key: "img_base_url",
        label: "接口地址",
        placeholder: "https://ark.cn-beijing.volces.com/api/v3",
        secret: false,
      },
      { key: "img_api_key", label: "API Key", placeholder: "ARK API Key", secret: true },
      {
        key: "img_model",
        label: "生图模型",
        placeholder: "doubao-seedream-4-0-250828",
        secret: false,
      },
    ],
  },
  {
    id: "video",
    label: "图生视频",
    title: "图生视频",
    hint: "视频工坊的镜头运镜用。火山方舟 Seedance 异步任务协议，需在方舟控制台开通视频模型——推荐 2.x（支持多图参考锁角色，模型 ID 按控制台实际开通填）。接口地址/API Key 留空时自动复用封面生图的配置",
    presets: VIDEO_PRESETS,
    fields: [
      {
        key: "video_base_url",
        label: "接口地址（留空复用封面生图）",
        placeholder: "https://ark.cn-beijing.volces.com/api/v3",
        secret: false,
      },
      {
        key: "video_api_key",
        label: "API Key（留空复用封面生图）",
        placeholder: "ARK API Key",
        secret: true,
      },
      {
        key: "video_model",
        label: "视频模型",
        placeholder: "doubao-seedance-1-0-pro-250528",
        secret: false,
      },
      {
        key: "video_duration",
        label: "镜头视频时长（秒，3~15；短镜更稳，长尾易漂移）",
        placeholder: "5",
        secret: false,
      },
    ],
  },
  {
    id: "tts",
    label: "配音 TTS",
    title: "配音 TTS",
    hint: "火山引擎语音合成（openspeech）。在火山控制台开通「语音合成」后获取 App ID 与 Access Token；音色填你开通的 voice_type",
    fields: [
      {
        key: "tts_app_id",
        label: "App ID",
        placeholder: "火山引擎语音应用 App ID",
        secret: false,
      },
      {
        key: "tts_access_token",
        label: "Access Token",
        placeholder: "火山引擎语音应用 Access Token",
        secret: true,
      },
      {
        key: "tts_cluster",
        label: "Cluster",
        placeholder: "volcano_tts",
        secret: false,
      },
      {
        key: "tts_voice",
        label: "音色 voice_type",
        placeholder: "如 zh_female_cancan_mars_bigtts",
        secret: false,
      },
    ],
  },
];

/** 主题预览卡：画出该主题的迷你界面（侧栏 + 卡片 + 文本行） */
function ThemeCard({
  label,
  active,
  onClick,
  bg,
  card,
  text,
  sub,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  bg: string;
  card: string;
  text: string;
  sub: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-xl bg-canvas p-2.5 text-left transition-shadow ${
        active ? "shadow-glow ring-2 ring-accent" : "shadow-card hover:shadow-lift"
      }`}
    >
      <div
        className="flex h-16 gap-1 overflow-hidden rounded-lg p-1.5"
        style={{ background: bg }}
      >
        <div className="flex w-3.5 flex-col gap-1">
          <div className="h-1.5 w-1.5 rounded-full" style={{ background: card }} />
          <div className="h-1.5 w-1.5 rounded-full" style={{ background: card }} />
          <div className="h-1.5 w-1.5 rounded-full" style={{ background: card }} />
        </div>
        <div className="flex-1 rounded" style={{ background: card }}>
          <div className="m-1.5 space-y-1">
            <div className="h-1 w-3/4 rounded-full" style={{ background: text }} />
            <div className="h-1 w-full rounded-full" style={{ background: sub }} />
            <div className="h-1 w-2/3 rounded-full" style={{ background: sub }} />
            <div
              className="mt-1 h-2 w-5 rounded-full"
              style={{ background: "#0a84ff" }}
            />
          </div>
        </div>
      </div>
      <span className="mt-1.5 block text-center text-[11px] font-medium text-body">
        {label}
      </span>
    </button>
  );
}

/** 设置页：左侧分类菜单 + 右侧对应配置组，不再一滚到底 */
export function SettingsView() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [activeId, setActiveId] = useState("general");

  // 常规（即时生效，不走保存按钮）
  const [theme, setTheme] = useState("light");
  const [font, setFont] = useState("serif");
  const [fontSize, setFontSize] = useState("17");

  useEffect(() => {
    void (async () => {
      const next: Record<string, string> = {};
      for (const g of SECTIONS) {
        for (const f of g.fields) {
          next[f.key] = (await api.getSetting(f.key)) ?? "";
        }
      }
      setValues(next);
      setTheme((await api.getSetting("ui_theme")) ?? "light");
      setFont((await api.getSetting("editor_font")) ?? "serif");
      setFontSize((await api.getSetting("editor_font_size")) ?? "17");
    })();
  }, []);

  /** 常规项：写入设置 + 立即应用 */
  const applyPref = async (key: string, value: string) => {
    await api.setSetting(key, value);
    await applyUiPrefs();
  };

  const save = async () => {
    for (const g of SECTIONS) {
      for (const f of g.fields) {
        await api.setSetting(f.key, values[f.key] ?? "");
      }
    }
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  };

  const active = SECTIONS.find((s) => s.id === activeId) ?? SECTIONS[0];

  return (
    <div className="flex min-h-0 flex-1">
      {/* 左侧：分类菜单 */}
      <nav className="w-44 shrink-0 overflow-y-auto p-4">
        <h1 className="px-2 pb-3 text-[15px] font-bold tracking-tight text-ink">
          设置
        </h1>
        <button
          onClick={() => setActiveId("general")}
          className={`block w-full rounded-[10px] px-2.5 py-2 text-left text-[13px] transition-colors ${
            activeId === "general"
              ? "bg-surface font-semibold text-ink shadow-card"
              : "text-body hover:bg-hover"
          }`}
        >
          常规
        </button>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setActiveId(s.id)}
            className={`block w-full rounded-[10px] px-2.5 py-2 text-left text-[13px] transition-colors ${
              s.id === activeId
                ? "bg-surface font-semibold text-ink shadow-card"
                : "text-body hover:bg-hover"
            }`}
          >
            {s.label}
          </button>
        ))}

        <div className="my-2 mx-2.5 h-px bg-track" />

        <button
          onClick={() => setActiveId("accounts")}
          className={`flex w-full items-center gap-1.5 rounded-[10px] px-2.5 py-2 text-left text-[13px] transition-colors ${
            activeId === "accounts"
              ? "bg-surface font-semibold text-ink shadow-card"
              : "text-body hover:bg-hover"
          }`}
        >
          平台账号
          <span className="rounded-full bg-track px-1.5 py-px text-[9px] text-muted">
            规划中
          </span>
        </button>

        <p className="px-2.5 pt-4 text-[11px] leading-5 text-faint">
          配置保存在本机，不会上传到任何服务器
        </p>
      </nav>

      {/* 右侧：当前分类 */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[880px] px-10 pt-6 pb-16">
          {activeId === "general" ? (
            <section className="rounded-2xl bg-surface p-6 shadow-card">
              <h3 className="text-[15px] font-semibold text-ink">常规</h3>
              <p className="mt-1 text-xs text-muted">即时生效，不用点保存</p>

              <p className="mt-5 text-xs font-medium text-muted">主题</p>
              <div className="mt-1.5 grid grid-cols-3 gap-2.5">
                <ThemeCard
                  label="浅色"
                  active={theme === "light"}
                  onClick={() => {
                    setTheme("light");
                    void applyPref("ui_theme", "light");
                  }}
                  bg="#f2f3f6"
                  card="#ffffff"
                  text="#1c1c1e"
                  sub="#8e8e93"
                />
                <ThemeCard
                  label="深色"
                  active={theme === "dark"}
                  onClick={() => {
                    setTheme("dark");
                    void applyPref("ui_theme", "dark");
                  }}
                  bg="#161618"
                  card="#2e2e32"
                  text="#f2f2f7"
                  sub="#9c9ca2"
                />
                <ThemeCard
                  label="跟随系统"
                  active={theme === "system"}
                  onClick={() => {
                    setTheme("system");
                    void applyPref("ui_theme", "system");
                  }}
                  bg="linear-gradient(135deg, #f2f3f6 50%, #161618 50%)"
                  card="#8b8b90"
                  text="#ffffff"
                  sub="#e5e5ea"
                />
              </div>

              <p className="mt-5 text-xs font-medium text-muted">编辑器正文字体</p>
              <div className="mt-1.5 grid grid-cols-3 gap-2.5">
                {(
                  [
                    ["serif", "衬线", "宋体系，纸感阅读"],
                    ["sans", "黑体", "屏幕阅读友好"],
                    ["kai", "楷体", "手写书卷气"],
                  ] as const
                ).map(([v, label, desc]) => (
                  <button
                    key={v}
                    onClick={() => {
                      setFont(v);
                      void applyPref("editor_font", v);
                    }}
                    className={`rounded-xl bg-canvas p-3 text-left transition-shadow ${
                      font === v ? "shadow-glow ring-2 ring-accent" : "shadow-card hover:shadow-lift"
                    }`}
                  >
                    <span
                      className="block truncate text-[15px] text-ink"
                      style={{ fontFamily: FONT_STACKS[v] }}
                    >
                      永和九年，岁在癸丑
                    </span>
                    <span className="mt-1 block text-[11px] font-semibold text-body">
                      {label}
                    </span>
                    <span className="block text-[10px] text-faint">{desc}</span>
                  </button>
                ))}
              </div>

              <p className="mt-5 text-xs font-medium text-muted">正文字号</p>
              <div className="mt-1.5 grid grid-cols-4 gap-2.5">
                {(["15", "17", "19", "21"] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => {
                      setFontSize(v);
                      void applyPref("editor_font_size", v);
                    }}
                    className={`rounded-xl bg-canvas p-3 text-center transition-shadow ${
                      fontSize === v
                        ? "shadow-glow ring-2 ring-accent"
                        : "shadow-card hover:shadow-lift"
                    }`}
                  >
                    <span
                      className="block text-ink"
                      style={{ fontSize: `${v}px`, fontFamily: FONT_STACKS[font] }}
                    >
                      字
                    </span>
                    <span className="mt-1 block text-[10px] text-faint">{v}px</span>
                  </button>
                ))}
              </div>
            </section>
          ) : activeId === "accounts" ? (
            <section className="rounded-2xl bg-card/45 p-6">
              <h3 className="text-[15px] font-semibold text-muted">平台账号</h3>
              <p className="mt-2 text-xs leading-6 text-muted">
                小说平台账号绑定、授权与分发管理将随 v0.5 提供（抖音 / TikTok /
                YouTube 走官方 API，小说平台做半自动填充）。
              </p>
            </section>
          ) : (
            <section className="rounded-2xl bg-surface p-6 shadow-card">
              <h3 className="text-[15px] font-semibold text-ink">
                {active.title}
              </h3>
              <p className="mt-1 mb-4 text-xs leading-5 text-muted">
                {active.hint}
              </p>
              {active.presets && (
                <label className="mb-3.5 block">
                  <span className="mb-1.5 block text-xs font-medium text-muted">
                    厂商预设（选中自动填下方配置，可再改）
                  </span>
                  <select
                    className="w-full rounded-[10px] bg-canvas px-3 py-2 text-sm outline-none focus:bg-surface2"
                    value=""
                    onChange={(e) => {
                      const p = active.presets?.find(
                        (x) => x.name === e.target.value,
                      );
                      if (!p) return;
                      // 空值不覆盖（如 OpenRouter 不带推荐模型，保留用户已填）
                      setValues((v) => {
                        const next = { ...v };
                        for (const [k, val] of Object.entries(p.fills)) {
                          if (val) next[k] = val;
                        }
                        return next;
                      });
                    }}
                  >
                    <option value="">选择厂商…</option>
                    {active.presets.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
                {active.fields.map((f) => (
                  <label key={f.key} className="block">
                    <span className="mb-1.5 block text-xs font-medium text-muted">
                      {f.label}
                    </span>
                    {f.options ? (
                      <select
                        className="w-full rounded-[10px] bg-canvas px-3 py-2 text-sm outline-none focus:bg-surface2"
                        value={values[f.key] ?? ""}
                        onChange={(e) =>
                          setValues((v) => ({ ...v, [f.key]: e.target.value }))
                        }
                      >
                        {f.options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={f.secret ? "password" : "text"}
                        className="w-full rounded-[10px] bg-canvas px-3 py-2 text-sm outline-none placeholder:text-faint focus:bg-surface2"
                        placeholder={f.placeholder}
                        value={values[f.key] ?? ""}
                        onChange={(e) =>
                          setValues((v) => ({ ...v, [f.key]: e.target.value }))
                        }
                      />
                    )}
                  </label>
                ))}
              </div>
            </section>
          )}

          {activeId !== "accounts" && (
            <div className="mt-6 flex items-center justify-end gap-3">
              {saved && <span className="text-xs text-pgreen-t">已保存</span>}
              <button
                className="rounded-full bg-accent px-6 py-2 text-sm font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h"
                onClick={() => void save()}
              >
                保存
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
