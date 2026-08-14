import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { BootstrapDraft, Style } from "../types";

interface AICreateWizardProps {
  onCancel: () => void;
  onCreate: (draft: BootstrapDraft) => void;
}

/**
 * AI 起书向导：一句话创意 → AI 策划书名/简介/初始设定库 → 人确认后成书。
 * AI 出草稿、人做主编——草稿可改、词条可删，确认才落库。
 */
export function AICreateWizard({ onCancel, onCreate }: AICreateWizardProps) {
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [polishBusy, setPolishBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<BootstrapDraft | null>(null);
  const [styles, setStyles] = useState<Style[]>([]);

  useEffect(() => {
    void api.listStyles().then(setStyles).catch(console.error);
  }, []);

  const generate = async () => {
    if (busy || idea.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      setDraft(await api.aiBootstrapDraft(idea.trim()));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 润色创意：粗糙的一句话 → 更具体的创作 brief，回填输入框可再改 */
  const polish = async () => {
    if (polishBusy || idea.trim().length === 0) return;
    setPolishBusy(true);
    setError(null);
    try {
      setIdea(await api.aiPolishIdea(idea.trim()));
    } catch (e) {
      setError(String(e));
    } finally {
      setPolishBusy(false);
    }
  };

  const removeLore = (i: number) => {
    if (!draft) return;
    setDraft({ ...draft, lore: draft.lore.filter((_, j) => j !== i) });
  };

  return (
    <div className="mt-6 rounded-2xl bg-surface p-6 shadow-card">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-ink">AI 辅助创建</h2>
        <button
          className="rounded-lg px-2 py-1 text-xs text-muted transition-colors hover:bg-hover hover:text-body"
          onClick={onCancel}
        >
          收起
        </button>
      </div>

      {!draft ? (
        <>
          <textarea
            autoFocus
            className="mt-4 h-24 w-full resize-none rounded-xl bg-canvas p-3 text-sm leading-6 text-body outline-none placeholder:text-faint focus:bg-surface2"
            placeholder="一句话创意，越具体越好。&#10;例：末法时代的灵气复苏，外卖小哥意外绑定地府外卖系统，给鬼送餐能获得阴德"
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void generate();
            }}
          />
          <div className="mt-3 flex items-center gap-3">
            <button
              disabled={busy || idea.trim().length === 0}
              className="rounded-full bg-accent px-5 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
              onClick={() => void generate()}
            >
              {busy ? "AI 策划中…" : "生成草稿"}
            </button>
            <button
              disabled={polishBusy || busy || idea.trim().length === 0}
              title="AI 把创意补得更具体：题材定位、主角、金手指、核心冲突与爽点"
              className="rounded-full bg-white/70 px-4 py-2 text-[13px] text-body shadow-card transition-colors hover:bg-hover disabled:opacity-40"
              onClick={() => void polish()}
            >
              {polishBusy ? "润色中…" : "润色创意"}
            </button>
            <span className="text-[11px] text-faint">
              没思路时先点「润色创意」，AI 帮你把一句话补完整
            </span>
          </div>
        </>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-[72px_1fr] items-center gap-x-3 gap-y-3">
            <span className="text-xs text-muted">书名</span>
            <input
              className="rounded-[10px] bg-canvas px-3 py-2 text-sm font-semibold text-ink outline-none focus:bg-surface2"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <span className="text-xs text-muted">题材标签</span>
            <input
              className="rounded-[10px] bg-canvas px-3 py-2 text-sm text-body outline-none focus:bg-surface2"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
            <span className="self-start pt-2 text-xs text-muted">作品简介</span>
            <textarea
              className="h-28 resize-none rounded-[10px] bg-canvas px-3 py-2 text-[13px] leading-6 text-body outline-none focus:bg-surface2"
              value={draft.synopsis}
              onChange={(e) => setDraft({ ...draft, synopsis: e.target.value })}
            />
            <span className="text-xs text-muted">字数目标</span>
            <div className="flex items-center gap-2">
              <input
                className="w-36 rounded-[10px] bg-canvas px-3 py-2 text-[13px] text-body outline-none placeholder:text-faint focus:bg-surface2"
                placeholder="全书，如 200000"
                inputMode="numeric"
                value={draft.target_total_words || ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    target_total_words: parseInt(e.target.value, 10) || undefined,
                  })
                }
              />
              <input
                className="w-36 rounded-[10px] bg-canvas px-3 py-2 text-[13px] text-body outline-none placeholder:text-faint focus:bg-surface2"
                placeholder="每章，如 2000"
                inputMode="numeric"
                value={draft.target_chapter_words || ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    target_chapter_words: parseInt(e.target.value, 10) || undefined,
                  })
                }
              />
              <span className="text-[11px] text-faint">可选</span>
            </div>
            {styles.length > 0 && (
              <>
                <span className="text-xs text-muted">写作风格</span>
                <select
                  className="w-64 rounded-[10px] bg-canvas px-3 py-2 text-[13px] text-body outline-none focus:bg-surface2"
                  value={draft.style_id ?? 0}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      style_id: parseInt(e.target.value, 10) || undefined,
                    })
                  }
                >
                  <option value={0}>不指定（默认风格）</option>
                  {styles.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>

          <p className="mt-5 mb-2 text-xs font-semibold text-muted">
            初始设定（{draft.lore.length} 条，进设定库）
          </p>
          <div className="flex flex-col gap-2">
            {draft.lore.map((l, i) => (
              <div key={i} className="rounded-xl bg-canvas p-3">
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-accent-soft px-2 py-px text-[10px] font-medium text-accent">
                    {l.category}
                  </span>
                  <span className="text-[13px] font-medium text-ink">{l.title}</span>
                  {l.always_include && (
                    <span className="rounded-full bg-pyellow px-2 py-px text-[10px] text-pyellow-t">
                      常驻注入
                    </span>
                  )}
                  <button
                    className="ml-auto text-faint hover:text-pred-t"
                    title="移除该词条"
                    onClick={() => removeLore(i)}
                  >
                    ×
                  </button>
                </div>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">
                  {l.content}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-5 flex items-center gap-3">
            <button
              className="rounded-full bg-accent px-5 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h"
              onClick={() => onCreate(draft)}
            >
              创建作品
            </button>
            <button
              disabled={busy}
              className="rounded-full bg-white/70 px-4 py-2 text-[13px] text-body shadow-card transition-colors hover:bg-hover disabled:opacity-40"
              onClick={() => void generate()}
            >
              {busy ? "AI 策划中…" : "换一版"}
            </button>
            <button
              className="px-3 py-2 text-xs text-muted hover:text-body"
              onClick={() => setDraft(null)}
            >
              返回改创意
            </button>
          </div>
        </>
      )}

      {error && (
        <p className="mt-3 rounded-xl bg-pred px-3.5 py-2.5 text-xs leading-5 text-pred-t">
          {error}
        </p>
      )}
    </div>
  );
}
