import { useEffect, useState } from "react";
import { api } from "../lib/api";

interface FieldDef {
  key: string;
  label: string;
  placeholder: string;
  secret: boolean;
}

interface SectionDef {
  id: string;
  label: string;
  title: string;
  hint: string;
  fields: FieldDef[];
}

const SECTIONS: SectionDef[] = [
  {
    id: "llm",
    label: "文本模型",
    title: "文本模型",
    hint: "续写 / 改写 / 摘要 / 起书策划 / 视频口播稿共用。兼容 OpenAI 对话协议：DeepSeek / 通义 / Kimi / OpenAI…",
    fields: [
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
    title: "封面生图 / 图生视频",
    hint: "兼容 OpenAI Images 协议，推荐火山方舟 Seedream（即梦）。分镜配图也用这组配置；图生视频复用同一把 Key，需在方舟控制台开通 Seedance 视频模型",
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
      {
        key: "video_model",
        label: "视频模型（图生视频）",
        placeholder: "doubao-seedance-1-0-pro-250528",
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

/** 设置页：左侧分类菜单 + 右侧对应配置组，不再一滚到底 */
export function SettingsView() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [activeId, setActiveId] = useState("llm");

  useEffect(() => {
    void (async () => {
      const next: Record<string, string> = {};
      for (const g of SECTIONS) {
        for (const f of g.fields) {
          next[f.key] = (await api.getSetting(f.key)) ?? "";
        }
      }
      setValues(next);
    })();
  }, []);

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

        <div className="my-2 mx-2.5 h-px bg-black/8" />

        <button
          onClick={() => setActiveId("accounts")}
          className={`flex w-full items-center gap-1.5 rounded-[10px] px-2.5 py-2 text-left text-[13px] transition-colors ${
            activeId === "accounts"
              ? "bg-surface font-semibold text-ink shadow-card"
              : "text-body hover:bg-hover"
          }`}
        >
          平台账号
          <span className="rounded-full bg-black/6 px-1.5 py-px text-[9px] text-muted">
            规划中
          </span>
        </button>

        <p className="px-2.5 pt-4 text-[11px] leading-5 text-faint">
          配置保存在本机，不会上传到任何服务器
        </p>
      </nav>

      {/* 右侧：当前分类 */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="max-w-[560px] px-8 pt-6 pb-16">
          {activeId === "accounts" ? (
            <section className="rounded-2xl bg-white/45 p-6">
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
              {active.fields.map((f) => (
                <label key={f.key} className="mb-3.5 block last:mb-0">
                  <span className="mb-1.5 block text-xs font-medium text-muted">
                    {f.label}
                  </span>
                  <input
                    type={f.secret ? "password" : "text"}
                    className="w-full rounded-[10px] bg-canvas px-3 py-2 text-sm outline-none placeholder:text-faint focus:bg-surface2"
                    placeholder={f.placeholder}
                    value={values[f.key] ?? ""}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [f.key]: e.target.value }))
                    }
                  />
                </label>
              ))}
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
