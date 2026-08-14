import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { BootstrapDraft, Project } from "../types";
import { AICreateWizard } from "./AICreateWizard";

interface BookshelfProps {
  projects: Project[];
  onOpen: (id: number) => void;
  onCreate: (name: string) => void;
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

/** 空白创建：次级入口，点开就地输入 */
function NewBookButton({ onCreate }: { onCreate: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  const submit = () => {
    const n = name.trim();
    if (!n) return;
    onCreate(n);
    setName("");
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        className="rounded-full bg-white/70 px-4 py-2 text-[13px] text-body shadow-card transition-colors hover:bg-surface"
        onClick={() => setOpen(true)}
      >
        空白创建
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-full bg-surface p-1.5 pl-4 shadow-card">
      <input
        autoFocus
        className="w-40 bg-transparent text-sm outline-none placeholder:text-faint"
        placeholder="作品名称"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <button
        className="rounded-full bg-accent px-3.5 py-1.5 text-xs font-semibold text-surface hover:bg-accent-h"
        onClick={submit}
      >
        创建
      </button>
      <button
        className="pr-2 text-xs text-muted hover:text-body"
        onClick={() => setOpen(false)}
      >
        取消
      </button>
    </div>
  );
}
