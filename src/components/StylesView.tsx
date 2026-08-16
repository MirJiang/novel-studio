import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { IMAGE_PRESETS, VIDEO_PRESETS } from "../lib/stylePresets";
import type { Style } from "../types";

interface StylesViewProps {
  /** 当前打开的作品（有则风格卡可一键应用） */
  currentProjectId: number | null;
  currentProjectStyleId: number;
  onApplied: () => void;
}

/**
 * 风格库：上传/粘贴参考小说文本 → LLM 蒸馏风格卡。
 * 风格全局复用，创建作品时选择，注入到 AI 续写/批量写章/划词处理。
 * 样本仅在本地分析，建议使用公版或免费授权作品。
 */
export function StylesView({
  currentProjectId,
  currentProjectStyleId,
  onApplied,
}: StylesViewProps) {
  const [styles, setStyles] = useState<Style[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** 页签：写作风格（蒸馏/对话生成）/ 图片画风 / 视频运镜 */
  const [tab, setTab] = useState<"text" | "image" | "video">("text");

  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [distilling, setDistilling] = useState(false);

  // 对话生成风格
  const [idea, setIdea] = useState("");
  const [cardPreview, setCardPreview] = useState<string | null>(null);
  const [tweak, setTweak] = useState("");
  const [cardBusy, setCardBusy] = useState(false);
  const [cardName, setCardName] = useState("");
  const [genOpen, setGenOpen] = useState(false); // 对话生成弹层
  const [distillOpen, setDistillOpen] = useState(false); // 上传蒸馏弹层

  const refresh = useCallback(async () => {
    try {
      setStyles(await api.listStyles());
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pickFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      setText(String(reader.result ?? ""));
      if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, ""));
    };
    reader.readAsText(file);
  };

  const doDistill = async () => {
    if (distilling) return;
    setDistilling(true);
    setError(null);
    try {
      await api.distillStyle(name.trim(), "本地文本", text);
      setText("");
      setName("");
      setDistillOpen(false);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setDistilling(false);
    }
  };

  /** 对话生成：描述出卡 / 带微调出卡（kind 跟随当前页签） */
  const genCard = async (isTweak: boolean) => {
    if (cardBusy) return;
    if (isTweak && (!cardPreview || !tweak.trim())) return;
    if (!isTweak && !idea.trim()) return;
    setCardBusy(true);
    setError(null);
    try {
      const card = await api.generateStyleCard(
        idea.trim(),
        isTweak ? cardPreview ?? undefined : undefined,
        isTweak ? tweak.trim() : undefined,
        tab
      );
      setCardPreview(card);
      setTweak("");
      if (!cardName.trim() && idea.trim()) setCardName(idea.trim().slice(0, 12));
    } catch (e) {
      setError(String(e));
    } finally {
      setCardBusy(false);
    }
  };

  const saveCard = async () => {
    if (!cardPreview || !cardName.trim()) return;
    try {
      await api.saveStyleCard(
        cardName.trim(),
        idea.trim() ? `对话生成：${idea.trim().slice(0, 30)}` : "对话生成",
        cardPreview,
        tab
      );
      setCardPreview(null);
      setIdea("");
      setCardName("");
      setGenOpen(false);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const applyToCurrent = async (styleId: number) => {
    if (currentProjectId == null) return;
    try {
      await api.setProjectStyle(currentProjectId, styleId);
      onApplied();
    } catch (e) {
      setError(String(e));
    }
  };

  const tabStyles = styles.filter((s) =>
    tab === "text" ? s.kind === "text" || !s.kind : s.kind === tab,
  );
  const presets = tab === "image" ? IMAGE_PRESETS : VIDEO_PRESETS;
  const ideaPlaceholder =
    tab === "text"
      ? "描述想要的风格，如：古龙风、番茄重生年代文的爽感"
      : tab === "image"
        ? "描述想要的画风，如：吉卜力水彩感、暗黑油画"
        : "描述想要的运镜，如：希区柯克变焦、环绕上升";

  const removeStyle = async (id: number) => {
    if (!window.confirm("确定删除这个风格吗？引用它的作品会恢复为不指定风格。"))
      return;
    await api.deleteStyle(id);
    await refresh();
    onApplied();
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl px-10 pt-10 pb-16">
        <div className="flex items-center gap-3.5">
          <h1 className="text-[26px] font-bold tracking-tight text-ink">
            风格库
          </h1>
          <span className="text-xs text-muted">{styles.length} 个风格</span>
          <div className="ml-auto flex gap-1 rounded-[10px] bg-track p-[3px]">
            {(
              [
                ["text", "小说写作"],
                ["image", "图片画风"],
                ["video", "视频运镜"],
              ] as const
            ).map(([t, label]) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-md px-4 py-1 text-xs font-medium transition-colors ${
                  tab === t
                    ? "bg-surface text-ink shadow-card"
                    : "text-muted hover:text-body"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {/* 创建入口（弹层，避免长卡片占列表位） */}
        <div className="mt-5 flex gap-2">
          <button
            className="flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h"
            onClick={() => setGenOpen(true)}
          >
            <svg viewBox="0 0 12 12" className="h-3 w-3">
              <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.8" />
            </svg>
            对话生成风格
          </button>
          {tab === "text" && (
            <button
              className="flex items-center gap-1.5 rounded-full bg-card/70 px-4 py-2 text-[13px] text-body shadow-card transition-colors hover:bg-surface"
              onClick={() => setDistillOpen(true)}
            >
              上传小说蒸馏
            </button>
          )}
        </div>

        {/* 图片/视频页签：内置预设（直接可用，无需添加） */}
        {tab !== "text" && (
          <div className="mt-5 grid grid-cols-2 gap-3 xl:grid-cols-3">
            {presets.map((p) => (
              <div
                key={p.name}
                className="rounded-2xl bg-surface p-4 shadow-card"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-bold text-ink">
                    {p.name}
                  </span>
                  <span className="ml-auto rounded-full bg-track px-2 py-0.5 text-[10px] text-muted">
                    内置
                  </span>
                </div>
                <p className="mt-1.5 text-[12px] leading-5 text-body">
                  {p.guide}
                </p>
                <p className="mt-1 text-[11px] text-faint">{p.desc}</p>
              </div>
            ))}
          </div>
        )}

        {/* 风格卡列表（按页签过滤，小卡片网格） */}
        <div className="mt-5 grid grid-cols-2 gap-3 xl:grid-cols-3">
          {tabStyles.map((s) => (
            <div key={s.id} className="flex flex-col rounded-2xl bg-surface p-4 shadow-card">
              <div className="flex items-center gap-2">
                <span className="truncate text-[14px] font-bold text-ink">{s.name}</span>
                {s.source === "内置" && (
                  <span className="rounded-full bg-track px-2 py-0.5 text-[10px] text-muted">
                    内置
                  </span>
                )}
                {s.sample_chars > 0 && (
                  <span className="text-[11px] text-faint">
                    样本 {s.sample_chars.toLocaleString()} 字
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  {tab === "text" &&
                    currentProjectId != null &&
                    (currentProjectStyleId === s.id ? (
                      <span className="rounded-full bg-pgreen px-2.5 py-1 text-[11px] text-pgreen-t">
                        当前作品使用中
                      </span>
                    ) : (
                      <button
                        onClick={() => void applyToCurrent(s.id)}
                        className="rounded-full bg-card/70 px-3 py-1.5 text-xs text-body shadow-card transition-colors hover:bg-surface"
                      >
                        应用
                      </button>
                    ))}
                  <button
                    title="删除风格"
                    onClick={() => void removeStyle(s.id)}
                    className="text-faint hover:text-pred-t"
                  >
                    ×
                  </button>
                </div>
              </div>
              <p className="mt-1.5 line-clamp-3 flex-1 text-[12px] leading-5 text-body">
                {s.guide}
              </p>
              {s.example && (
                <p className="mt-1.5 line-clamp-1 rounded-lg bg-canvas px-2.5 py-1.5 text-[11px] leading-4 text-faint">
                  示例：{s.example}
                </p>
              )}
            </div>
          ))}
          {tabStyles.length === 0 && (
            <p className="col-span-full py-10 text-center text-[13px] text-faint">
              {tab === "text"
                ? "还没有风格，导入一本参考小说蒸馏一个"
                : "内置预设可直接用；对话生成的自定义风格会列在这里"}
            </p>
          )}
        </div>
      </div>

      {/* 对话生成弹层 */}
      {genOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => setGenOpen(false)}
        >
          <div className="mx-4" onClick={(e) => e.stopPropagation()}>
        {/* 对话生成风格（三类页签共用，kind 跟随页签） */}
        <div className="w-full max-w-lg rounded-2xl bg-surface p-5 shadow-float">
          <div className="flex items-center">
            <p className="text-[13px] font-semibold text-ink">对话生成风格</p>
            <button
              className="ml-auto text-faint hover:text-body"
              onClick={() => setGenOpen(false)}
            >
              ×
            </button>
          </div>
          <div className="mt-2 flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-[10px] bg-canvas px-3 py-2 text-[13px] outline-none placeholder:text-faint focus:bg-surface2"
              placeholder={ideaPlaceholder}
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void genCard(false)}
            />
            <button
              disabled={cardBusy || !idea.trim()}
              onClick={() => void genCard(false)}
              className="shrink-0 rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
            >
              {cardBusy && !cardPreview ? "生成中…" : "生成风格卡"}
            </button>
          </div>
          {cardPreview && (
            <div className="mt-3">
              <p className="whitespace-pre-wrap rounded-xl bg-canvas px-3.5 py-3 text-[13px] leading-6 text-body">
                {cardPreview}
              </p>
              <div className="mt-2 flex gap-2">
                <input
                  className="min-w-0 flex-1 rounded-[10px] bg-canvas px-3 py-2 text-[13px] outline-none placeholder:text-faint focus:bg-surface2"
                  placeholder="微调，如：句子再短一点，对话再多些"
                  value={tweak}
                  disabled={cardBusy}
                  onChange={(e) => setTweak(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void genCard(true)}
                />
                <button
                  disabled={cardBusy || !tweak.trim()}
                  onClick={() => void genCard(true)}
                  className="shrink-0 rounded-full bg-card/70 px-4 py-2 text-[13px] text-body shadow-card transition-colors hover:bg-surface disabled:opacity-40"
                >
                  {cardBusy ? "调整中…" : "调整"}
                </button>
              </div>
              <div className="mt-2 flex gap-2">
                <input
                  className="min-w-0 flex-1 rounded-[10px] bg-canvas px-3 py-2 text-[13px] outline-none placeholder:text-faint focus:bg-surface2"
                  placeholder="风格名称"
                  value={cardName}
                  onChange={(e) => setCardName(e.target.value)}
                />
                <button
                  disabled={!cardName.trim()}
                  onClick={() => void saveCard()}
                  className="shrink-0 rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
                >
                  保存到风格库
                </button>
              </div>
            </div>
          )}
        </div>

          </div>
        </div>
      )}

      {/* 上传蒸馏弹层 */}
      {distillOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => setDistillOpen(false)}
        >
          <div className="mx-4 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        {/* 创建风格卡片（上传文本蒸馏，仅写作页签） */}
        <div className="w-full max-w-lg rounded-2xl bg-surface p-5 shadow-float">
          <div className="mb-2 flex items-center">
            <p className="text-[13px] font-semibold text-ink">上传小说蒸馏</p>
            <button
              className="ml-auto text-faint hover:text-body"
              onClick={() => setDistillOpen(false)}
            >
              ×
            </button>
          </div>
          <div className="flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-[10px] bg-canvas px-3 py-2 text-[13px] outline-none placeholder:text-faint focus:bg-surface2"
              placeholder="风格名称，如：古龙风"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              onClick={() => fileRef.current?.click()}
              className="shrink-0 rounded-full bg-card/70 px-4 py-2 text-[13px] text-body shadow-card transition-colors hover:bg-surface"
            >
              导入 txt
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pickFile(f);
                e.target.value = "";
              }}
            />
          </div>
          <textarea
            className="mt-2 h-36 w-full resize-none rounded-[10px] bg-canvas px-3 py-2 text-[13px] leading-6 outline-none placeholder:text-faint focus:bg-surface2"
            placeholder="或直接粘贴参考文本（至少 500 字，建议几千字以上，蒸馏更准）"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-faint">
              {text.length > 0 ? `已粘贴 ${text.length.toLocaleString()} 字` : ""}
            </span>
            <button
              disabled={distilling || !name.trim() || text.trim().length < 500}
              onClick={() => void doDistill()}
              className="rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
            >
              {distilling ? "蒸馏中…" : "蒸馏风格"}
            </button>
          </div>

          {error && (
            <p className="mt-3 rounded-xl bg-pred px-3.5 py-2.5 text-xs leading-5 text-pred-t">
              {error}
            </p>
          )}
        </div>

          </div>
        </div>
      )}
    </div>
  );
}
