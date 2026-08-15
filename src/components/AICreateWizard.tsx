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
    if (!Array.isArray(d.outline)) d.outline = [];
    if (!Array.isArray(d.opening)) d.opening = [];
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

type DraftTab = "base" | "lore" | "outline" | "opening";

/**
 * AI 起书向导（对话式，整页覆盖层）：左侧 AI 策划对话，右侧草稿面板
 * （基础信息/设定/大纲/开篇流程 四个页签，全部可编辑）。
 * 覆盖层常驻挂载（收起只是隐藏），会话自动存库归档。
 */
export function AICreateWizard({ onCancel, onCreate, startFresh, onFreshConsumed }: AICreateWizardProps) {
  const [messages, setMessages] = useState<UiMsg[]>([
    { role: "ai", text: GREETING },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<BootstrapDraft | null>(null);
  const [draftTab, setDraftTab] = useState<DraftTab>("base");
  const [draftGenerating, setDraftGenerating] = useState(false); // [DRAFT] 已出现，JSON 生成中
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
    const historyMsgs: ChatMsg[] = [...messages, { role: "user" as const, text: content }]
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
    setDraftGenerating(false);
    let acc = "";
    try {
      await api.aiBootstrapChatStream(historyMsgs, (ev) => {
        if (ev.type === "delta") {
          acc += ev.text;
          // [DRAFT] 之后的 JSON 不上屏：气泡只显示策划思路，JSON 收起为生成状态
          const pos = acc.indexOf("[DRAFT]");
          const generating = pos >= 0;
          setDraftGenerating(generating);
          const visible = generating ? acc.slice(0, pos).trimEnd() : acc;
          setMessages((prev) => {
            const next = [...prev];
            next[next.length - 1] = {
              role: "ai",
              text: visible + (generating ? "\n\n*方案草稿生成中…*" : ""),
            };
            return next;
          });
        } else if (ev.type === "error") {
          setError(ev.message);
        }
      });
      // 流结束：拆草稿；会话落库归档
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
      setDraftGenerating(false);
    }
  };

  const removeLore = (i: number) => {
    if (!draft) return;
    setDraft({ ...draft, lore: draft.lore.filter((_, j) => j !== i) });
  };

  const tabs: [DraftTab, string, number?][] = [
    ["base", "基础信息"],
    ["lore", "设定", draft?.lore.length],
    ["outline", "大纲", draft?.outline?.length],
    ["opening", "开篇流程", draft?.opening?.length],
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <div className="mx-auto flex w-full max-w-6xl min-h-0 flex-1 flex-col px-8 pt-6 pb-5">
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

        {/* 左右分栏：对话 | 草稿 */}
        <div className="mt-3 flex min-h-0 flex-1 gap-4">
          {/* 左：对话 */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div
              ref={chatRef}
              className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto rounded-2xl bg-surface p-5 shadow-card"
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
          </div>

          {/* 右：草稿面板（页签） */}
          <div className="flex w-[400px] shrink-0 flex-col rounded-2xl bg-surface shadow-card">
            <div className="flex shrink-0 gap-1 p-3 pb-0">
              {tabs.map(([id, label, count]) => (
                <button
                  key={id}
                  onClick={() => setDraftTab(id)}
                  className={`rounded-full px-3 py-1.5 text-[12px] transition-colors ${
                    draftTab === id
                      ? "bg-accent-soft font-semibold text-accent"
                      : "text-muted hover:text-body"
                  }`}
                >
                  {label}
                  {count != null && count > 0 ? ` ${count}` : ""}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {!draft ? (
                <div className="flex h-full items-center justify-center px-6 text-center">
                  <p className="text-[13px] leading-6 text-faint">
                    {draftGenerating ? (
                      <>
                        <span className="mb-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                        <br />
                        方案草稿生成中，生成完自动填充…
                      </>
                    ) : (
                      <>
                        聊着聊着，新书的草稿会出现在这里：
                        <br />
                        基础信息 / 初始设定 / 分卷大纲 / 开篇流程
                      </>
                    )}
                  </p>
                </div>
              ) : draftTab === "base" ? (
                <div className="flex flex-col gap-3">
                  <label className="block">
                    <span className="mb-1 block text-xs text-muted">书名</span>
                    <input
                      className="w-full rounded-[10px] bg-canvas px-3 py-2 text-sm font-semibold text-ink outline-none focus:bg-surface2"
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-muted">题材标签</span>
                    <input
                      className="w-full rounded-[10px] bg-canvas px-3 py-2 text-[13px] text-body outline-none focus:bg-surface2"
                      value={draft.description}
                      onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-muted">作品简介</span>
                    <textarea
                      className="h-36 w-full resize-none rounded-[10px] bg-canvas px-3 py-2 text-[13px] leading-6 text-body outline-none focus:bg-surface2"
                      value={draft.synopsis}
                      onChange={(e) => setDraft({ ...draft, synopsis: e.target.value })}
                    />
                  </label>
                  <div>
                    <span className="mb-1 block text-xs text-muted">字数目标</span>
                    <div className="flex items-center gap-2">
                      <input
                        className="w-32 rounded-[10px] bg-canvas px-3 py-2 text-[13px] text-body outline-none placeholder:text-faint focus:bg-surface2"
                        placeholder="全书"
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
                        className="w-32 rounded-[10px] bg-canvas px-3 py-2 text-[13px] text-body outline-none placeholder:text-faint focus:bg-surface2"
                        placeholder="每章"
                        inputMode="numeric"
                        value={draft.target_chapter_words || ""}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            target_chapter_words: parseInt(e.target.value, 10) || undefined,
                          })
                        }
                      />
                    </div>
                  </div>
                  {styles.length > 0 && (
                    <label className="block">
                      <span className="mb-1 block text-xs text-muted">写作风格</span>
                      <select
                        className="w-full rounded-[10px] bg-canvas px-3 py-2 text-[13px] text-body outline-none focus:bg-surface2"
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
                    </label>
                  )}
                </div>
              ) : draftTab === "lore" ? (
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
                  {draft.lore.length === 0 && (
                    <p className="py-6 text-center text-xs text-faint">无设定词条</p>
                  )}
                </div>
              ) : draftTab === "outline" ? (
                <div className="flex flex-col gap-2">
                  {(draft.outline ?? []).map((o, i) => (
                    <div key={i} className="rounded-xl bg-canvas p-3">
                      <div className="flex items-center gap-2">
                        <input
                          className="min-w-0 flex-1 rounded-lg bg-surface px-2 py-1 text-[13px] font-medium text-ink outline-none"
                          value={o.title}
                          onChange={(e) => {
                            const next = [...(draft.outline ?? [])];
                            next[i] = { ...o, title: e.target.value };
                            setDraft({ ...draft, outline: next });
                          }}
                        />
                        <button
                          className="text-faint hover:text-pred-t"
                          title="移除该节点"
                          onClick={() => {
                            setDraft({
                              ...draft,
                              outline: (draft.outline ?? []).filter((_, j) => j !== i),
                            });
                          }}
                        >
                          ×
                        </button>
                      </div>
                      <textarea
                        className="mt-1.5 h-16 w-full resize-none rounded-lg bg-surface px-2 py-1.5 text-xs leading-5 text-muted outline-none focus:text-body"
                        value={o.content}
                        onChange={(e) => {
                          const next = [...(draft.outline ?? [])];
                          next[i] = { ...o, content: e.target.value };
                          setDraft({ ...draft, outline: next });
                        }}
                      />
                    </div>
                  ))}
                  {(draft.outline ?? []).length === 0 && (
                    <p className="py-6 text-center text-xs text-faint">
                      草稿里没有大纲节点，可以叫策划补上
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {(draft.opening ?? []).map((line, i) => (
                    <div key={i} className="flex items-start gap-2 rounded-xl bg-canvas p-2.5">
                      <span className="mt-0.5 shrink-0 text-[10px] text-faint">
                        {i + 1}
                      </span>
                      <textarea
                        className="min-h-8 min-w-0 flex-1 resize-none rounded-lg bg-surface px-2 py-1 text-xs leading-5 text-body outline-none"
                        value={line}
                        rows={2}
                        onChange={(e) => {
                          const next = [...(draft.opening ?? [])];
                          next[i] = e.target.value;
                          setDraft({ ...draft, opening: next });
                        }}
                      />
                      <button
                        className="mt-0.5 text-faint hover:text-pred-t"
                        title="移除"
                        onClick={() => {
                          setDraft({
                            ...draft,
                            opening: (draft.opening ?? []).filter((_, j) => j !== i),
                          });
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {(draft.opening ?? []).length === 0 && (
                    <p className="py-6 text-center text-xs text-faint">
                      草稿里没有开篇流程，可以叫策划补上
                    </p>
                  )}
                </div>
              )}
            </div>

            {draft && (
              <div className="flex shrink-0 items-center gap-3 border-t border-line p-4">
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
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
