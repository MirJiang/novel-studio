import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { AiMarkdown } from "./Markdown";
import type { ChatMsg, ScopeItem } from "../types";

interface AssistantPanelProps {
  projectId: number;
  /** 当前打开的章节（有则可改写、对话带上当前章上下文） */
  chapterId: number | null;
  chapterTitle: string | null;
  /** 改写替换成功后回调（刷新章节列表/编辑器） */
  onChapterReplaced: (chapterId: number) => void;
  onClose: () => void;
}

interface UiMsg {
  role: "user" | "ai";
  text: string;
}

/**
 * 写作助手悬浮抽屉：对整本书对话（设定+摘要链+大纲+当前章注入），
 * 支持单章改写——流式预览，确认后才替换原文并自动重生成摘要。
 */
export function AssistantPanel({
  projectId,
  chapterId,
  chapterTitle,
  onChapterReplaced,
  onClose,
}: AssistantPanelProps) {
  const [messages, setMessages] = useState<UiMsg[]>([
    {
      role: "ai",
      text: "我是这本书的责编助手，设定、剧情进度、大纲我都看得到。聊走向、问设定、让我改哪章都行。",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 改写状态
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [rewriting, setRewriting] = useState(false);
  const [applying, setApplying] = useState(false);

  // 跨章改写状态
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeInstr, setScopeInstr] = useState("");
  const [scopeBusy, setScopeBusy] = useState(false);
  const [scopeItems, setScopeItems] = useState<ScopeItem[] | null>(null);
  const [scopeChecked, setScopeChecked] = useState<Set<number>>(new Set());
  const [info, setInfo] = useState<string | null>(null);

  const chatRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [messages]);

  const send = async () => {
    const content = input.trim();
    if (!content || busy) return;
    setError(null);
    setNote(null);
    const history: ChatMsg[] = [...messages, { role: "user" as const, text: content }]
      .map((m) => ({
        role: (m.role === "ai" ? "assistant" : "user") as "user" | "assistant",
        content: m.text,
      }));
    setMessages((prev) => [
      ...prev,
      { role: "user", text: content },
      { role: "ai", text: "" },
    ]);
    setInput("");
    setBusy(true);
    let acc = "";
    try {
      await api.assistantChat(projectId, chapterId, history, (ev) => {
        if (ev.type === "meta") setNote(ev.note);
        else if (ev.type === "delta") {
          acc += ev.text;
          const cur = acc;
          setMessages((prev) => {
            const next = [...prev];
            next[next.length - 1] = { role: "ai", text: cur };
            return next;
          });
        } else if (ev.type === "error") setError(ev.message);
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const startRewrite = async () => {
    if (!chapterId || rewriting || !instruction.trim()) return;
    setError(null);
    setPreview(null);
    setRewriting(true);
    let acc = "";
    try {
      await api.assistantRewriteChapter(chapterId, instruction.trim(), (ev) => {
        if (ev.type === "delta") {
          acc += ev.text;
          setPreview(acc);
        } else if (ev.type === "error") setError(ev.message);
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setRewriting(false);
    }
  };

  /** 确认替换：纯文本转段落 HTML 落库 → 自动重生成摘要 → 通知 App 刷新 */
  const applyRewrite = async () => {
    if (!chapterId || !chapterTitle || !preview || applying) return;
    setApplying(true);
    setError(null);
    try {
      const html = preview
        .split(/\n+/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map(
          (l) =>
            `<p>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`
        )
        .join("");
      await api.saveChapter(chapterId, chapterTitle, html);
      await api.generateSummary(chapterId); // 摘要链保持新鲜
      onChapterReplaced(chapterId);
      setPreview(null);
      setRewriteOpen(false);
      setInstruction("");
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying(false);
    }
  };

  /** 定位影响范围 */
  const locateScope = async () => {
    if (scopeBusy || !scopeInstr.trim()) return;
    setScopeBusy(true);
    setError(null);
    setInfo(null);
    try {
      const items = await api.locateRewriteScope(projectId, scopeInstr.trim());
      setScopeItems(items);
      setScopeChecked(new Set(items.map((i) => i.chapter_id)));
      if (items.length === 0) setInfo("AI 判断没有章节受影响——可以换个说法再定位");
    } catch (e) {
      setError(String(e));
    } finally {
      setScopeBusy(false);
    }
  };

  /** 确认范围后入队（快照/进度/取消都在任务队列里） */
  const enqueueScope = async () => {
    if (scopeChecked.size === 0) return;
    try {
      await api.enqueueRewriteChapters(
        projectId,
        [...scopeChecked],
        scopeInstr.trim()
      );
      setInfo(`已入队，将改写 ${scopeChecked.size} 章（任务页可看进度/回滚）`);
      setScopeItems(null);
      setScopeInstr("");
      setScopeOpen(false);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="fixed bottom-11 right-0 top-11 z-40 flex w-[400px] flex-col border-l border-line bg-surface shadow-float">
      <div className="flex shrink-0 items-center gap-2 px-4 py-3">
        <h2 className="text-[15px] font-bold text-ink">AI 助手</h2>
        <button
          className="ml-auto text-faint hover:text-body"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      {note && (
        <p className="shrink-0 px-4 pb-2 text-[10px] leading-4 text-faint">
          注入：{note}
        </p>
      )}

      {/* 对话区 */}
      <div
        ref={chatRef}
        className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 pb-3"
      >
        {messages.map((m, i) => (
          <div
            key={i}
            className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-6 ${
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

      {/* 改写预览区 */}
      {(rewriteOpen || preview != null) && chapterId && (
        <div className="flex max-h-[45%] shrink-0 flex-col border-t border-line p-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted">
              改写《{chapterTitle}》
            </span>
            <button
              className="ml-auto text-faint hover:text-body"
              onClick={() => {
                setRewriteOpen(false);
                setPreview(null);
              }}
            >
              ✕
            </button>
          </div>
          {preview == null ? (
            <div className="mt-2 flex gap-2">
              <input
                className="min-w-0 flex-1 rounded-[10px] bg-canvas px-3 py-2 text-[13px] outline-none placeholder:text-faint focus:bg-surface2"
                placeholder="改写要求，如：让主角更强势"
                value={instruction}
                disabled={rewriting}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void startRewrite()}
              />
              <button
                disabled={rewriting || !instruction.trim()}
                onClick={() => void startRewrite()}
                className="shrink-0 rounded-full bg-accent px-3.5 py-2 text-xs font-semibold text-surface shadow-glow hover:bg-accent-h disabled:opacity-40"
              >
                {rewriting ? "改写中…" : "生成预览"}
              </button>
            </div>
          ) : (
            <>
              <div className="mt-2 min-h-0 flex-1 overflow-y-auto rounded-xl bg-canvas p-3 text-[12px] leading-5 text-body">
                <div className="whitespace-pre-wrap">{preview}</div>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  disabled={rewriting || applying}
                  onClick={() => void applyRewrite()}
                  className="rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-surface shadow-glow hover:bg-accent-h disabled:opacity-40"
                >
                  {applying ? "替换中…" : "替换原文并更新摘要"}
                </button>
                <button
                  disabled={applying}
                  onClick={() => setPreview(null)}
                  className="rounded-full bg-card/70 px-3 py-1.5 text-xs text-body shadow-card hover:bg-surface"
                >
                  重写
                </button>
                <span className="text-[10px] text-faint">不替换不会动原文</span>
              </div>
            </>
          )}
        </div>
      )}

      {error && (
        <p className="shrink-0 px-4 pb-2 text-xs leading-5 text-pred-t">{error}</p>
      )}
      {info && (
        <p className="shrink-0 px-4 pb-2 text-xs leading-5 text-pgreen-t">{info}</p>
      )}

      {/* 跨章改写区 */}
      {scopeOpen && (
        <div className="flex max-h-[45%] shrink-0 flex-col border-t border-line p-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted">跨章改写</span>
            <button
              className="ml-auto text-faint hover:text-body"
              onClick={() => setScopeOpen(false)}
            >
              ✕
            </button>
          </div>
          <div className="mt-2 flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-[10px] bg-canvas px-3 py-2 text-[13px] outline-none placeholder:text-faint focus:bg-surface2"
              placeholder="如：把金手指从系统改成血脉"
              value={scopeInstr}
              disabled={scopeBusy}
              onChange={(e) => setScopeInstr(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void locateScope()}
            />
            <button
              disabled={scopeBusy || !scopeInstr.trim()}
              onClick={() => void locateScope()}
              className="shrink-0 rounded-full bg-accent px-3.5 py-2 text-xs font-semibold text-surface shadow-glow hover:bg-accent-h disabled:opacity-40"
            >
              {scopeBusy ? "定位中…" : "定位影响范围"}
            </button>
          </div>
          {scopeItems != null && scopeItems.length > 0 && (
            <>
              <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
                {scopeItems.map((it) => (
                  <label
                    key={it.chapter_id}
                    className="flex cursor-pointer items-center gap-2 py-1 text-[13px] text-body"
                  >
                    <input
                      type="checkbox"
                      className="accent-[#007AFF]"
                      checked={scopeChecked.has(it.chapter_id)}
                      onChange={(e) => {
                        const next = new Set(scopeChecked);
                        if (e.target.checked) next.add(it.chapter_id);
                        else next.delete(it.chapter_id);
                        setScopeChecked(next);
                      }}
                    />
                    <span className="truncate font-medium text-ink">{it.title}</span>
                    <span className="truncate text-[11px] text-faint">{it.reason}</span>
                  </label>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  disabled={scopeChecked.size === 0}
                  onClick={() => void enqueueScope()}
                  className="rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-surface shadow-glow hover:bg-accent-h disabled:opacity-40"
                >
                  确认改写 {scopeChecked.size} 章（入队）
                </button>
                <span className="text-[10px] text-faint">
                  每章改写前自动快照，可整批回滚
                </span>
              </div>
            </>
          )}
        </div>
      )}

      {/* 输入区 */}
      <div className="flex shrink-0 gap-2 border-t border-line p-3">
        <input
          className="min-w-0 flex-1 rounded-[10px] bg-canvas px-3 py-2 text-[13px] outline-none placeholder:text-faint focus:bg-surface2"
          placeholder="问剧情、聊走向、要建议…"
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void send()}
        />
        <button
          disabled={busy || !input.trim()}
          onClick={() => void send()}
          className="shrink-0 rounded-full bg-accent px-3.5 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
        >
          发送
        </button>
        <button
          disabled={!chapterId || busy || rewriting}
          title={chapterId ? `改写《${chapterTitle}》` : "先打开一个章节"}
          onClick={() => setRewriteOpen((v) => !v)}
          className="shrink-0 rounded-full bg-card/70 px-3.5 py-2 text-[13px] text-body shadow-card transition-colors hover:bg-surface disabled:opacity-40"
        >
          改写本章
        </button>
        <button
          disabled={busy || scopeBusy}
          title="按摘要链定位受影响章节，确认后批量改写"
          onClick={() => setScopeOpen((v) => !v)}
          className="shrink-0 rounded-full bg-card/70 px-3.5 py-2 text-[13px] text-body shadow-card transition-colors hover:bg-surface disabled:opacity-40"
        >
          跨章改写
        </button>
      </div>
    </div>
  );
}
