import { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor as TiptapEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { api, type StreamEvent } from "../lib/api";
import type { Chapter } from "../types";

interface EditorProps {
  chapter: Chapter;
  /** 保存成功后通知父组件（刷新侧栏字数等） */
  onSaved: () => void;
}

interface SelInfo {
  from: number;
  to: number;
  text: string;
  top: number;
  left: number;
}

/**
 * 位置感知的流式插入器：从 startPos 开始追加文本，\n 切成新段落。
 * 用位置而不是光标，避免流式期间用户点选/滚动导致插错位置。
 */
function makeInserter(ed: TiptapEditor, startPos: number) {
  let pos = startPos;
  return (text: string) => {
    for (const seg of text.split(/(\n)/)) {
      if (seg === "\n") {
        ed.chain().insertContentAt(pos, "<p></p>").run();
        pos += 1; // 进入新段落内部
      } else if (seg) {
        ed.chain().insertContentAt(pos, seg).run();
        pos += seg.length;
      }
    }
  };
}

export function Editor({ chapter, onSaved }: EditorProps) {
  const [title, setTitle] = useState(chapter.title);
  const titleRef = useRef(title);
  titleRef.current = title;

  const [instruction, setInstruction] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const aiBusyRef = useRef(false);
  aiBusyRef.current = aiBusy;
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);

  // 划词浮动条
  const [sel, setSel] = useState<SelInfo | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 摘要面板
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summary, setSummary] = useState(chapter.summary);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  const summaryDirtyRef = useRef(false);
  const summaryTimer = useRef<number | null>(null);

  const saveTimer = useRef<number | null>(null);
  const pendingRef = useRef<{ title: string; content: string } | null>(null);
  const chapterIdRef = useRef(chapter.id);
  chapterIdRef.current = chapter.id;

  // ---------- 正文保存 ----------

  const flushSave = useCallback(async () => {
    if (saveTimer.current != null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    try {
      await api.saveChapter(chapterIdRef.current, pending.title, pending.content);
      onSaved();
    } catch (e) {
      console.error("保存失败", e);
    }
  }, [onSaved]);

  const scheduleSave = useCallback(
    (nextTitle: string, content: string) => {
      pendingRef.current = { title: nextTitle, content };
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void flushSave(), 800);
    },
    [flushSave]
  );

  // ---------- 摘要保存 ----------

  const flushSummary = useCallback(async () => {
    if (summaryTimer.current != null) {
      window.clearTimeout(summaryTimer.current);
      summaryTimer.current = null;
    }
    if (!summaryDirtyRef.current) return;
    summaryDirtyRef.current = false;
    try {
      await api.saveSummary(chapterIdRef.current, summaryRef.current);
    } catch (e) {
      console.error("保存摘要失败", e);
    }
  }, []);

  const scheduleSummarySave = useCallback(() => {
    summaryDirtyRef.current = true;
    if (summaryTimer.current != null) window.clearTimeout(summaryTimer.current);
    summaryTimer.current = window.setTimeout(() => void flushSummary(), 800);
  }, [flushSummary]);

  // 卸载兜底保存
  useEffect(() => {
    return () => {
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      const pending = pendingRef.current;
      if (pending) {
        void api.saveChapter(chapterIdRef.current, pending.title, pending.content);
      }
      if (summaryTimer.current != null) window.clearTimeout(summaryTimer.current);
      if (summaryDirtyRef.current) {
        void api.saveSummary(chapterIdRef.current, summaryRef.current);
      }
    };
  }, []);

  // ---------- 编辑器 ----------

  const editor = useEditor({
    extensions: [StarterKit],
    content: chapter.content || "",
    editorProps: { attributes: { class: "tiptap" } },
    onUpdate: ({ editor: ed }) => {
      scheduleSave(titleRef.current, ed.getHTML());
    },
    onSelectionUpdate: ({ editor: ed }) => {
      if (aiBusyRef.current) return; // 流式期间不弹浮动条
      const { from, to, empty } = ed.state.selection;
      const wrap = scrollRef.current;
      if (empty || !wrap) {
        setSel(null);
        return;
      }
      const text = ed.state.doc.textBetween(from, to).trim();
      if (!text) {
        setSel(null);
        return;
      }
      const coords = ed.view.coordsAtPos(from);
      const rect = wrap.getBoundingClientRect();
      setSel({
        from,
        to,
        text,
        top: coords.top - rect.top + wrap.scrollTop,
        left: coords.left - rect.left,
      });
    },
  });
  const editorRef = useRef<TiptapEditor | null>(null);
  editorRef.current = editor;

  // ---------- AI 流式公共部分 ----------

  const makeStreamHandler = useCallback(
    (insert: (text: string) => void) => (event: StreamEvent) => {
      if (event.type === "meta") {
        setAiNote(event.note);
      } else if (event.type === "delta") {
        insert(event.text);
      } else if (event.type === "error") {
        setAiMessage(event.message);
      } else if (event.type === "done") {
        setAiBusy(false);
        void flushSave();
      }
    },
    [flushSave]
  );

  const beginAi = () => {
    setAiBusy(true);
    setAiMessage(null);
    setAiNote(null);
  };

  // ---------- AI 续写 ----------

  const runAiContinue = async () => {
    const ed = editorRef.current;
    if (!ed || aiBusy) return;
    beginAi();
    setSel(null);
    // 续写前先落盘，保证后端读到的是最新内容
    await flushSave();
    const insert = makeInserter(ed, ed.state.doc.content.size);
    try {
      await api.aiContinue(chapter.id, instruction, makeStreamHandler(insert));
    } catch (e) {
      setAiMessage(String(e));
      setAiBusy(false);
    }
  };

  // ---------- 划词改写/润色/扩写 ----------

  const runTransform = async (mode: string) => {
    const ed = editorRef.current;
    if (!ed || aiBusy || !sel) return;
    const { from, to, text } = sel;
    beginAi();
    setSel(null);
    await flushSave();
    // 删除选区，从原位置流式插入新文本
    ed.chain().focus().deleteRange({ from, to }).run();
    const insert = makeInserter(ed, from);
    try {
      await api.aiTransform(chapter.id, mode, text, makeStreamHandler(insert));
    } catch (e) {
      setAiMessage(String(e));
      setAiBusy(false);
    }
  };

  // ---------- 摘要生成 ----------

  const runGenerateSummary = async () => {
    if (summaryBusy) return;
    setSummaryBusy(true);
    setAiMessage(null);
    await flushSave();
    try {
      const s = await api.generateSummary(chapter.id);
      setSummary(s);
      summaryDirtyRef.current = false; // 后端已存
      setSummaryOpen(true);
    } catch (e) {
      setAiMessage(String(e));
    } finally {
      setSummaryBusy(false);
    }
  };

  const wordCount = editor
    ? editor.getText().replace(/\s/g, "").length
    : chapter.word_count;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* AI 操作栏 */}
      <div className="flex shrink-0 items-center gap-2 px-5 pb-2.5">
        <input
          className="min-w-0 flex-1 rounded-[10px] bg-white/60 px-3 py-2 text-[13px] shadow-card outline-none placeholder:text-faint focus:bg-surface"
          placeholder="续写要求（可选），如：让主角在此刻觉醒血脉"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void runAiContinue()}
        />
        <button
          disabled={aiBusy}
          onClick={() => void runAiContinue()}
          className="shrink-0 rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
        >
          {aiBusy ? "生成中…" : "AI 续写"}
        </button>
      </div>

      {/* 写作区（relative 供划词浮动条定位） */}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[680px] px-8 pt-6 pb-24">
          <input
            className="w-full bg-transparent font-display text-[34px] font-bold tracking-tight text-ink outline-none placeholder:text-faint"
            placeholder="章节标题"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (editorRef.current) {
                scheduleSave(e.target.value, editorRef.current.getHTML());
              }
            }}
          />

          {/* 元信息 + 摘要入口 */}
          <div className="mt-3 flex items-center gap-2.5 text-xs text-muted">
            <span>{wordCount} 字</span>
            <span className="text-faint">·</span>
            <button
              className="hover:text-body"
              onClick={() => setSummaryOpen((v) => !v)}
            >
              {summaryOpen ? "▾" : "▸"} 本章摘要
              {summary ? `（已生成 ${summary.length} 字）` : "（未生成）"}
            </button>
            <button
              disabled={summaryBusy}
              onClick={() => void runGenerateSummary()}
              className="ml-auto rounded-lg px-2 py-1 text-body transition-colors hover:bg-hover disabled:opacity-40"
            >
              {summaryBusy
                ? "生成中…"
                : summary
                  ? "重新生成摘要"
                  : "AI 生成摘要"}
            </button>
          </div>

          {/* 摘要面板：续写时会注入，支撑长篇一致性 */}
          {summaryOpen && (
            <div className="mt-3 rounded-2xl bg-surface p-3.5 shadow-card">
              <textarea
                className="h-24 w-full resize-none bg-transparent text-xs leading-6 text-body outline-none placeholder:text-faint"
                placeholder="摘要会注入后续章节的续写上下文，支撑长篇一致性。可手写也可点上方生成。"
                value={summary}
                onChange={(e) => {
                  setSummary(e.target.value);
                  scheduleSummarySave();
                }}
              />
              <p className="mt-1 text-[11px] text-faint">
                修改自动保存；续写时摘要预算 1500 字，优先保留近期章节。
              </p>
            </div>
          )}

          {aiNote && (
            <div className="mt-4 rounded-xl bg-white/60 px-3.5 py-2.5 text-[11px] leading-5 text-muted shadow-card">
              {aiNote}
            </div>
          )}
          {aiMessage && (
            <p className="mt-3 rounded-xl bg-pred px-3.5 py-2.5 text-xs text-pred-t">
              {aiMessage}
            </p>
          )}

          <div className="mt-6">
            <EditorContent editor={editor} />
          </div>
        </div>

        {/* 划词浮动工具条 */}
        {sel && !aiBusy && (
          <div
            className="absolute z-20 flex -translate-y-full items-center gap-0.5 rounded-xl bg-[rgba(40,40,44,.92)] p-1 shadow-float backdrop-blur"
            style={{ top: sel.top - 6, left: sel.left }}
          >
            <BubbleButton label="改写" onClick={() => void runTransform("rewrite")} />
            <BubbleButton label="润色" onClick={() => void runTransform("polish")} />
            <BubbleButton label="扩写" onClick={() => void runTransform("expand")} />
          </div>
        )}
      </div>
    </div>
  );
}

function BubbleButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      className="rounded-lg px-3 py-1.5 text-xs font-medium text-[#E5E5EA] transition-colors hover:bg-white/14 hover:text-white"
      onMouseDown={(e) => e.preventDefault()} // 防止点击时选区丢失
      onClick={onClick}
    >
      {label}
    </button>
  );
}
