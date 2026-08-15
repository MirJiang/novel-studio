import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { api } from "../lib/api";
import type { BootstrapDraft, ChatMsg, ChatSession, Style } from "../types";

interface AICreateWizardProps {
  /** 关闭覆盖层（对话已持久化，随时可回） */
  onCancel: () => void;
  onCreate: (draft: BootstrapDraft) => void;
  /** 创建成功后重新挂载时为 true：跳过恢复，直接开新会话 */
  startFresh?: boolean;
  /** startFresh 生效后回调（清掉 App 侧的标记） */
  onFreshConsumed?: () => void;
}

interface UiMsg {
  role: "user" | "ai";
  text: string;
}

const GREETING =
  "想写本什么样的书？一句话说说你的想法就行——题材、主角、爽点，想到哪说到哪，我来帮你把它策划成一本能追更的网文。";

const VALID_CATEGORIES = ["人物", "世界观", "地点", "物品", "伏笔", "其他"];

/** 从完整回复里拆 [DRAFT] 草稿（流式 done 后调用）；解析失败整段当普通回复 */
function parseReply(raw: string): { reply: string; draft: BootstrapDraft | null } {
  const pos = raw.indexOf("[DRAFT]");
  if (pos < 0) return { reply: raw.trim(), draft: null };
  const reply = raw.slice(0, pos).trim();
  const rest = raw.slice(pos + 7);
  const start = rest.indexOf("{");
  const end = rest.lastIndexOf("}");
  if (start < 0 || end <= start) return { reply: raw.trim(), draft: null };
  try {
    const d = JSON.parse(rest.slice(start, end + 1)) as BootstrapDraft;
    if (!d.name || !Array.isArray(d.lore)) throw new Error("bad draft");
    d.lore = d.lore
      .filter((l) => l.title && l.title.trim())
      .map((l) => ({
        ...l,
        category: VALID_CATEGORIES.includes(l.category) ? l.category : "其他",
      }));
    return { reply: reply || "策划方案好了，看看：", draft: d };
  } catch {
    return { reply: raw.trim(), draft: null };
  }
}

/** AI 气泡的 Markdown 渲染（加粗/列表/标题按设计系统排） */
function AiMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      components={{
        p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
        strong: ({ children }) => (
          <strong className="font-semibold text-ink">{children}</strong>
        ),
        ul: ({ children }) => (
          <ul className="my-1.5 list-disc space-y-1 pl-5">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="my-1.5 list-decimal space-y-1 pl-5">{children}</ol>
        ),
        li: ({ children }) => <li className="leading-6">{children}</li>,
        h1: ({ children }) => <p className="mt-2 font-bold text-ink">{children}</p>,
        h2: ({ children }) => <p className="mt-2 font-bold text-ink">{children}</p>,
        h3: ({ children }) => <p className="mt-2 font-semibold text-ink">{children}</p>,
        code: ({ children }) => (
          <code className="rounded bg-black/6 px-1 py-0.5 text-[12px]">{children}</code>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

/**
 * AI 起书向导（对话式，整页覆盖层）：AI 策划多轮提问，信息够了自动产出草稿。
 * 覆盖层由 App 常驻挂载（关闭只是隐藏），对话与草稿不会因误点导航丢失；
 * 创建成功后 App 会重置本组件开始下一段对话。
 */
export function AICreateWizard({ onCancel, onCreate, startFresh, onFreshConsumed }: AICreateWizardProps) {
  const [messages, setMessages] = useState<UiMsg[]>([
    { role: "ai", text: GREETING },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<BootstrapDraft | null>(null);
  const [styles, setStyles] = useState<Style[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [history, setHistory] = useState<ChatSession[] | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.listStyles().then(setStyles).catch(console.error);
    // 恢复上次会话（创建成功后重挂载时跳过，直接开新会话）
    if (startFresh) {
      onFreshConsumed?.();
      return;
    }
    void api
      .getLatestChatSession()
      .then((s) => {
        if (!s) return;
        try {
          const msgs = JSON.parse(s.messages) as UiMsg[];
          if (msgs.length > 0) setMessages(msgs);
          if (s.draft) setDraft(JSON.parse(s.draft) as BootstrapDraft);
          setSessionId(s.id);
        } catch {
          /* 数据损坏当新会话 */
        }
      })
      .catch(console.error);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** 持久化当前会话（归档即此：旧会话留在库里，新会话另起一行） */
  const persist = (msgs: UiMsg[], d: BootstrapDraft | null, sid: number | null) => {
    const clean = msgs.filter((m) => m.text.trim());
    if (clean.length <= 1) return; // 只有开场白没什么可存的
    const title = clean.find((m) => m.role === "user")?.text.slice(0, 20) ?? "新会话";
    void api
      .saveChatSession(sid, title, JSON.stringify(clean), d ? JSON.stringify(d) : "")
      .then((id) => setSessionId(id))
      .catch(console.error);
  };

  const startNewSession = () => {
    setMessages([{ role: "ai", text: GREETING }]);
    setDraft(null);
    setSessionId(null);
    setHistory(null);
    setError(null);
  };

  const loadSession = (s: ChatSession) => {
    try {
      const msgs = JSON.parse(s.messages) as UiMsg[];
      setMessages(msgs.length > 0 ? msgs : [{ role: "ai", text: GREETING }]);
      setDraft(s.draft ? (JSON.parse(s.draft) as BootstrapDraft) : null);
      setSessionId(s.id);
      setHistory(null);
      setError(null);
    } catch {
      setError("该会话数据损坏，无法恢复");
    }
  };

  const toggleHistory = async () => {
    if (history != null) {
      setHistory(null);
      return;
    }
    try {
      setHistory(await api.listChatSessions());
    } catch (e) {
      setError(String(e));
    }
  };

  // 新消息/流式增量滚到底部
  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [messages]);

  // 草稿编辑自动落库（防抖 800ms）
  const draftTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!draft) return;
    if (draftTimer.current != null) window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => {
      persist(messages, draft, sessionId);
    }, 800);
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || busy) return;
    setError(null);
    const history: ChatMsg[] = [...messages, { role: "user" as const, text: content }]
      .map((m) => ({
        role: (m.role === "ai" ? "assistant" : "user") as "user" | "assistant",
        content: m.text,
      }));
    // 先上屏：用户消息 + 空的 AI 气泡（流式填充）
    setMessages((prev) => [
      ...prev,
      { role: "user", text: content },
      { role: "ai", text: "" },
    ]);
    setInput("");
    setBusy(true);
    let acc = "";
    try {
      await api.aiBootstrapChatStream(history, (ev) => {
        if (ev.type === "delta") {
          acc += ev.text;
          const cur = acc;
          setMessages((prev) => {
            const next = [...prev];
            next[next.length - 1] = { role: "ai", text: cur };
            return next;
          });
        } else if (ev.type === "error") {
          setError(ev.message);
        }
      });
      // 流结束：拆草稿；[DRAFT] 标记从气泡里剥掉；会话落库归档
      const { reply, draft: d } = parseReply(acc);
      const finalMsgs: UiMsg[] = [
        ...messages,
        { role: "user", text: content },
        { role: "ai", text: reply },
      ];
      setMessages(finalMsgs);
      const nextDraft = d ?? draft;
      if (d) setDraft(d);
      persist(finalMsgs, nextDraft, sessionId);
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
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <div className="mx-auto flex w-full max-w-3xl min-h-0 flex-1 flex-col px-10 pt-8 pb-6">
        <div className="flex items-center gap-2.5">
          <h1 className="text-[22px] font-bold tracking-tight text-ink">
            AI 辅助创建
          </h1>
          <span className="text-[11px] text-faint">
            聊清楚再开书；会话自动保存
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              className="rounded-full bg-white/70 px-3.5 py-1.5 text-[13px] text-body shadow-card transition-colors hover:bg-surface"
              onClick={() => void toggleHistory()}
            >
              历史
            </button>
            <button
              className="rounded-full bg-white/70 px-3.5 py-1.5 text-[13px] text-body shadow-card transition-colors hover:bg-surface"
              onClick={startNewSession}
              title="当前会话自动归档到历史，可回看"
            >
              新会话
            </button>
            <button
              className="rounded-full bg-white/70 px-4 py-1.5 text-[13px] text-body shadow-card transition-colors hover:bg-surface"
              onClick={onCancel}
            >
              收起 ↓
            </button>
          </div>
        </div>

        {/* 历史会话面板 */}
        {history != null && (
          <div className="mt-3 max-h-44 shrink-0 overflow-y-auto rounded-2xl bg-surface p-3 shadow-card">
            {history.length === 0 && (
              <p className="py-3 text-center text-xs text-faint">还没有历史会话</p>
            )}
            {history.map((s) => (
              <div
                key={s.id}
                className={`flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 transition-colors hover:bg-canvas ${
                  s.id === sessionId ? "bg-canvas" : ""
                }`}
                onClick={() => loadSession(s)}
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-body">
                  {s.title}
                </span>
                {s.draft && (
                  <span className="rounded-full bg-accent-soft px-2 py-px text-[10px] text-accent">
                    有草稿
                  </span>
                )}
                <span className="text-[10px] text-faint">
                  {new Date(s.updated_at * 1000).toLocaleString("zh-CN", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <button
                  className="text-faint hover:text-pred-t"
                  title="删除这条会话"
                  onClick={(e) => {
                    e.stopPropagation();
                    void api.deleteChatSession(s.id).then(() => {
                      setHistory((h) => h?.filter((x) => x.id !== s.id) ?? null);
                    });
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 对话区 */}
        <div
          ref={chatRef}
          className="mt-4 flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto rounded-2xl bg-surface p-5 shadow-card"
        >
          {messages.map((m, i) => (
            <div
              key={i}
              className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-6 ${
                m.role === "ai"
                  ? "self-start bg-canvas text-body"
                  : "self-end whitespace-pre-wrap bg-accent text-surface"
              }`}
            >
              {m.role === "ai" ? (
                m.text ? (
                  <AiMarkdown text={m.text} />
                ) : busy && i === messages.length - 1 ? (
                  "…"
                ) : null
              ) : (
                m.text
              )}
            </div>
          ))}
        </div>

        {/* 输入区 */}
        <div className="mt-3 flex shrink-0 gap-2">
          <input
            className="min-w-0 flex-1 rounded-[10px] bg-white/70 px-3 py-2.5 text-[13px] shadow-card outline-none placeholder:text-faint focus:bg-surface"
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
          <p className="mt-3 shrink-0 rounded-xl bg-pred px-3.5 py-2.5 text-xs leading-5 text-pred-t">
            {error}
          </p>
        )}

        {/* 草稿编辑（对话产出后显示） */}
        {draft && (
          <div className="mt-4 shrink-0 rounded-2xl bg-surface p-5 shadow-card">
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
                className="h-24 resize-none rounded-[10px] bg-canvas px-3 py-2 text-[13px] leading-6 text-body outline-none focus:bg-surface2"
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

            <p className="mt-4 mb-2 text-xs font-semibold text-muted">
              初始设定（{draft.lore.length} 条，进设定库）
            </p>
            <div className="flex max-h-44 flex-col gap-2 overflow-y-auto">
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

            <div className="mt-4 flex items-center gap-3">
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
    </div>
  );
}
