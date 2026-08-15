import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { BootstrapDraft, ChatMsg, Style } from "../types";

interface AICreateWizardProps {
  onCancel: () => void;
  onCreate: (draft: BootstrapDraft) => void;
}

interface UiMsg {
  role: "user" | "ai";
  text: string;
}

const GREETING =
  "想写本什么样的书？一句话说说你的想法就行——题材、主角、爽点，想到哪说到哪，我来帮你把它策划成一本能追更的网文。";

/**
 * AI 起书向导（对话式）：AI 策划像编辑一样多轮提问，把题材/卖点/主角/爽点/篇幅
 * 聊清楚后自动产出草稿；草稿可改、词条可删，确认才落库。
 * 也可以随时点「直接生成」跳过问答。
 */
export function AICreateWizard({ onCancel, onCreate }: AICreateWizardProps) {
  const [messages, setMessages] = useState<UiMsg[]>([
    { role: "ai", text: GREETING },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<BootstrapDraft | null>(null);
  const [styles, setStyles] = useState<Style[]>([]);
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.listStyles().then(setStyles).catch(console.error);
  }, []);

  // 新消息滚到底部
  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [messages, busy]);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || busy) return;
    setError(null);
    const nextMsgs: UiMsg[] = [...messages, { role: "user", text: content }];
    setMessages(nextMsgs);
    setInput("");
    setBusy(true);
    try {
      const history: ChatMsg[] = nextMsgs.map((m) => ({
        role: m.role === "ai" ? "assistant" : "user",
        content: m.text,
      }));
      const r = await api.aiBootstrapChat(history);
      setMessages((prev) => [...prev, { role: "ai", text: r.reply }]);
      if (r.draft) setDraft(r.draft);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeLore = (i: number) => {
    if (!draft) return;
    setDraft({ ...draft, lore: draft.lore.filter((_, j) => j !== i) });
  };

  return (
    <div className="mt-6 rounded-2xl bg-surface p-6 shadow-card">
      <div className="flex items-center gap-2.5">
        <h2 className="text-[15px] font-bold text-ink">AI 辅助创建</h2>
        <span className="text-[11px] text-faint">
          聊清楚再开书：题材 → 卖点 → 主角 → 爽点 → 篇幅
        </span>
        <button
          className="ml-auto text-faint hover:text-body"
          onClick={onCancel}
        >
          ✕
        </button>
      </div>

      {/* 对话区 */}
      <div
        ref={chatRef}
        className="mt-4 flex max-h-72 min-h-32 flex-col gap-2.5 overflow-y-auto rounded-xl bg-canvas p-4"
      >
        {messages.map((m, i) => (
          <div
            key={i}
            className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-[13px] leading-6 ${
              m.role === "ai"
                ? "self-start bg-surface text-body shadow-card"
                : "self-end bg-accent text-surface"
            }`}
          >
            {m.text}
          </div>
        ))}
        {busy && (
          <div className="self-start rounded-2xl bg-surface px-3.5 py-2.5 text-[13px] text-faint shadow-card">
            策划思考中…
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div className="mt-3 flex gap-2">
        <input
          className="min-w-0 flex-1 rounded-[10px] bg-canvas px-3 py-2 text-[13px] outline-none placeholder:text-faint focus:bg-surface2"
          placeholder="回复策划，或补充你的想法…"
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void send(input)}
        />
        <button
          disabled={busy || !input.trim()}
          onClick={() => void send(input)}
          className="shrink-0 rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
        >
          发送
        </button>
        <button
          disabled={busy}
          title="跳过问答，按现有信息直接出方案"
          onClick={() => void send("信息够了，直接生成方案")}
          className="shrink-0 rounded-full bg-white/70 px-3.5 py-2 text-[13px] text-body shadow-card transition-colors hover:bg-surface disabled:opacity-40"
        >
          直接生成
        </button>
      </div>

      {error && (
        <p className="mt-3 rounded-xl bg-pred px-3.5 py-2.5 text-xs leading-5 text-pred-t">
          {error}
        </p>
      )}

      {/* 草稿编辑（对话产出后显示） */}
      {draft && (
        <div className="mt-5 border-t border-line pt-5">
          <div className="grid grid-cols-[72px_1fr] items-center gap-x-3 gap-y-3">
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
              onClick={() => void send("换个方向，再来一版")}
            >
              换一版
            </button>
            <button
              className="px-3 py-2 text-xs text-muted hover:text-body"
              onClick={() => setDraft(null)}
            >
              继续聊
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
