import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { BootstrapDraft, Project, Style } from "../types";
import { AICreateWizard } from "./AICreateWizard";

interface BookshelfProps {
  projects: Project[];
  onOpen: (id: number) => void;
  onCreate: (
    name: string,
    targetTotalWords?: number,
    targetChapterWords?: number,
    styleId?: number
  ) => void;
  onAiCreate: (draft: BootstrapDraft) => void;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
}

/** 无封面时的兜底渐变色 */
const TILE_GRADIENTS = [
  "linear-gradient(155deg,#E8857A,#C2504A)",
  "linear-gradient(155deg,#6E9BD8,#3D5F9E)",
  "linear-gradient(155deg,#7FAE8A,#46705A)",
  "linear-gradient(155deg,#9B8AC4,#5F4E8C)",
];

/**
 * 书架首页：所有作品以封面卡片网格展示。
 * 封面取封面工坊的最新一张；没生成过则用渐变 + 衬线书名。
 */
export function Bookshelf(props: BookshelfProps) {
  const [wizardOpen, setWizardOpen] = useState(false);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-10 pt-10 pb-16">
          <div className="flex items-center gap-3.5">
            <h1 className="text-[26px] font-bold tracking-tight text-ink">
              书架
            </h1>
            <span className="text-xs text-muted">
              {props.projects.length} 部作品
            </span>
            <div className="ml-auto flex items-center gap-2">
              <NewBookButton onCreate={props.onCreate} />
              <button
                className="flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h"
                onClick={() => setWizardOpen((v) => !v)}
              >
                <svg viewBox="0 0 12 12" className="h-3 w-3">
                  <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.8" />
                </svg>
                AI 辅助创建
              </button>
            </div>
          </div>

          {wizardOpen && (
            <AICreateWizard
              onCancel={() => setWizardOpen(false)}
              onCreate={(d) => {
                setWizardOpen(false);
                props.onAiCreate(d);
              }}
            />
          )}

          <div className="mt-8 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-6 gap-y-9">
            {props.projects.map((p, i) => (
              <BookCard
                key={p.id}
                project={p}
                gradient={TILE_GRADIENTS[i % TILE_GRADIENTS.length]}
                onOpen={props.onOpen}
                onRename={props.onRename}
                onDelete={props.onDelete}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function BookCard({
  project,
  gradient,
  onOpen,
  onRename,
  onDelete,
}: {
  project: Project;
  gradient: string;
  onOpen: (id: number) => void;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
}) {
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [stats, setStats] = useState<{ chapters: number; words: number } | null>(
    null
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(project.name);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const covers = await api.listCovers(project.id);
        if (covers.length > 0) {
          const url = await api.getCoverData(covers[0]); // list_covers 按时间倒序
          if (!cancelled) setCoverUrl(url);
        }
      } catch {
        /* 无封面目录时走渐变色块 */
      }
      try {
        const chapters = await api.listChapters(project.id);
        if (!cancelled) {
          setStats({
            chapters: chapters.length,
            words: chapters.reduce((s, c) => s + c.word_count, 0),
          });
        }
      } catch (e) {
        console.error(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const submitRename = () => {
    const n = name.trim();
    setRenaming(false);
    if (n && n !== project.name) onRename(project.id, n);
    else setName(project.name);
  };

  const confirmDelete = () => {
    setMenuOpen(false);
    if (
      window.confirm(
        `确定删除《${project.name}》吗？\n\n该作品下的全部章节、设定、封面与视频都会被删除，不可恢复。`
      )
    ) {
      onDelete(project.id);
    }
  };

  return (
    <div className="group relative rounded-2xl bg-white/65 p-3 shadow-card transition-all duration-200 hover:-translate-y-1 hover:shadow-lift">
      {/* 打开作品：封面 + 信息区整体是按钮（菜单是它的兄弟，不嵌套） */}
      <button
        className="block w-full text-left"
        onClick={() => !renaming && onOpen(project.id)}
      >
        <div className="aspect-[3/4] w-full overflow-hidden rounded-xl shadow-card">
          {coverUrl ? (
            <img
              src={coverUrl}
              alt={project.name}
              className="h-full w-full object-cover"
            />
          ) : (
            <div
              className="flex h-full w-full flex-col p-4"
              style={{ background: gradient }}
            >
              <span className="font-display text-xl leading-relaxed font-bold tracking-wider text-white/95">
                {project.name}
              </span>
              <span className="mt-auto self-start rounded-full bg-white/20 px-2.5 py-1 text-[10px] tracking-widest text-white/80 backdrop-blur">
                {project.description || "原创小说"}
              </span>
            </div>
          )}
        </div>
        <div className="mt-2.5 px-1 pb-0.5">
          {renaming ? (
            <input
              autoFocus
              className="w-full rounded-md bg-canvas px-2 py-1 text-[13.5px] font-semibold text-ink outline-none focus:bg-surface2"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={submitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRename();
                if (e.key === "Escape") {
                  setName(project.name);
                  setRenaming(false);
                }
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <div className="truncate text-[13.5px] font-semibold text-ink">
              {project.name}
            </div>
          )}
          <div className="mt-0.5 text-[11px] text-muted">
            {stats == null
              ? "…"
              : stats.chapters === 0
                ? "尚无章节"
                : `${stats.chapters} 章 · ${stats.words.toLocaleString()} 字`}
          </div>
        </div>
      </button>

      {/* ⋯ 菜单（悬停显现） */}
      <div className="absolute top-5 right-5 z-10">
        <button
          className="flex h-7 w-7 items-center justify-center rounded-full bg-black/25 text-sm text-white opacity-0 backdrop-blur transition-opacity group-hover:opacity-100 hover:bg-black/45"
          onClick={() => setMenuOpen((v) => !v)}
          title="更多"
        >
          ⋯
        </button>
        {menuOpen && (
          <div className="absolute right-0 mt-1 w-28 overflow-hidden rounded-xl bg-surface py-1 shadow-float">
            <button
              className="block w-full px-3 py-1.5 text-left text-xs text-body hover:bg-hover"
              onClick={() => {
                setMenuOpen(false);
                setRenaming(true);
              }}
            >
              重命名
            </button>
            <button
              className="block w-full px-3 py-1.5 text-left text-xs text-pred-t hover:bg-pred"
              onClick={confirmDelete}
            >
              删除作品
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** 解析可选字数输入：空/非法 → undefined（即不设置） */
function parseWords(s: string): number | undefined {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 空白创建：次级入口，点开弹出小卡片（书名 + 可选字数目标 + 写作风格） */
function NewBookButton({
  onCreate,
}: {
  onCreate: (
    name: string,
    targetTotalWords?: number,
    targetChapterWords?: number,
    styleId?: number
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [totalWords, setTotalWords] = useState("");
  const [chapterWords, setChapterWords] = useState("");
  const [styles, setStyles] = useState<Style[]>([]);
  const [styleId, setStyleId] = useState(0);

  // 打开卡片时拉风格库（全局资源，通常没几个，随开随拉保证最新）
  useEffect(() => {
    if (open) void api.listStyles().then(setStyles).catch(console.error);
  }, [open]);

  const submit = () => {
    const n = name.trim();
    if (!n) return;
    onCreate(
      n,
      parseWords(totalWords),
      parseWords(chapterWords),
      styleId > 0 ? styleId : undefined
    );
    setName("");
    setTotalWords("");
    setChapterWords("");
    setStyleId(0);
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        className="rounded-full bg-white/70 px-4 py-2 text-[13px] text-body shadow-card transition-colors hover:bg-surface"
        onClick={() => setOpen((v) => !v)}
      >
        空白创建
      </button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-2 w-64 rounded-2xl bg-surface p-4 shadow-float">
          <input
            autoFocus
            className="w-full rounded-[10px] bg-canvas px-3 py-2 text-sm text-ink outline-none placeholder:text-faint focus:bg-surface2"
            placeholder="作品名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") setOpen(false);
            }}
          />
          <input
            className="mt-2 w-full rounded-[10px] bg-canvas px-3 py-2 text-[13px] text-body outline-none placeholder:text-faint focus:bg-surface2"
            placeholder="全书目标字数（可选，如 200000）"
            inputMode="numeric"
            value={totalWords}
            onChange={(e) => setTotalWords(e.target.value)}
          />
          <input
            className="mt-2 w-full rounded-[10px] bg-canvas px-3 py-2 text-[13px] text-body outline-none placeholder:text-faint focus:bg-surface2"
            placeholder="每章字数（可选，如 2000）"
            inputMode="numeric"
            value={chapterWords}
            onChange={(e) => setChapterWords(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") setOpen(false);
            }}
          />
          {styles.length > 0 && (
            <select
              className="mt-2 w-full rounded-[10px] bg-canvas px-3 py-2 text-[13px] text-body outline-none focus:bg-surface2"
              value={styleId}
              onChange={(e) => setStyleId(parseInt(e.target.value, 10))}
            >
              <option value={0}>写作风格（可选，默认无）</option>
              {styles.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          <p className="mt-2 text-[11px] leading-4 text-faint">
            填了字数目标后，写作页可一键「写完整本书」
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              className="rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-surface hover:bg-accent-h"
              onClick={submit}
            >
              创建
            </button>
            <button
              className="px-2 py-1.5 text-xs text-muted hover:text-body"
              onClick={() => setOpen(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
