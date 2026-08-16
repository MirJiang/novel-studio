import { useState } from "react";
import type { ChapterMeta, LoreEntry, OutlineItem } from "../types";

interface SidebarProps {
  chapters: ChapterMeta[];
  loreEntries: LoreEntry[];
  outlineItems: OutlineItem[];
  currentChapterId: number | null;
  currentLoreId: number | null;
  outlineActive: boolean;
  onSelectChapter: (id: number) => void;
  onCreateChapter: () => void;
  onDeleteChapter: (id: number) => void;
  onSelectLore: (id: number) => void;
  onCreateLore: () => void;
  onDeleteLore: (id: number) => void;
  onSelectOutline: () => void;
  /** 打开封面工坊（整页视图，侧栏隐藏） */
  onSelectCover: () => void;
}

type Tab = "chapters" | "lore" | "outline";

/** 写作视图侧栏：只属于当前作品，作品切换在书架页进行 */
export function Sidebar(props: SidebarProps) {
  const [tab, setTab] = useState<Tab>("chapters");

  return (
    <aside className="flex w-60 shrink-0 flex-col bg-card/45">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-3 pb-3">
        {/* 章节 / 设定 / 大纲 三 Tab（分段控件） */}
        <div className="mx-1 mt-2 flex gap-1 rounded-[10px] bg-track p-[3px]">
          <button
            className={`flex-1 rounded-md py-1 text-xs font-medium transition-colors ${
              tab === "chapters"
                ? "bg-surface text-ink shadow-card"
                : "text-muted hover:text-body"
            }`}
            onClick={() => setTab("chapters")}
          >
            章节
          </button>
          <button
            className={`flex-1 rounded-md py-1 text-xs font-medium transition-colors ${
              tab === "lore"
                ? "bg-surface text-ink shadow-card"
                : "text-muted hover:text-body"
            }`}
            onClick={() => setTab("lore")}
          >
            设定库
          </button>
          <button
            className={`flex-1 rounded-md py-1 text-xs font-medium transition-colors ${
              tab === "outline"
                ? "bg-surface text-ink shadow-card"
                : "text-muted hover:text-body"
            }`}
            onClick={() => setTab("outline")}
          >
            大纲
          </button>
        </div>

        <div className="mt-1.5 flex-1">
          {tab === "chapters" ? (
            <ChapterList {...props} />
          ) : tab === "lore" ? (
            <LoreList {...props} />
          ) : (
            <OutlineList {...props} />
          )}
        </div>

        <button
          className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-black/15 py-1.5 text-xs text-muted transition-colors hover:border-black/25 hover:bg-hover hover:text-body"
          onClick={
            tab === "chapters"
              ? props.onCreateChapter
              : tab === "lore"
                ? props.onCreateLore
                : props.onSelectOutline
          }
        >
          <svg viewBox="0 0 12 12" className="h-3 w-3">
            <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          {tab === "chapters" ? "新章节" : tab === "lore" ? "新词条" : "管理大纲"}
        </button>

        {/* 封面工坊入口（封面已从全局导航并入写作/书籍详情） */}
        <button
          className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-[10px] bg-card/60 py-1.5 text-xs text-muted shadow-card transition-colors hover:bg-surface hover:text-body"
          onClick={props.onSelectCover}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
          封面工坊
        </button>
      </div>
    </aside>
  );
}

/** 大纲 Tab：节点紧凑列表，点击进主区大纲视图 */
function OutlineList(props: SidebarProps) {
  return (
    <>
      {/* 作品简介入口 */}
      <div
        className={`flex cursor-pointer items-center rounded-[10px] px-2 py-1.5 transition-colors ${
          props.outlineActive ? "bg-surface shadow-card" : "hover:bg-hover"
        }`}
        onClick={props.onSelectOutline}
      >
        <span className="text-[13px] font-medium text-ink">作品简介与大纲</span>
        <span className="ml-auto text-[11px] text-faint">
          {props.outlineItems.length > 0
            ? `${props.outlineItems.filter((i) => i.status === "done").length}/${props.outlineItems.length}`
            : "未建"}
        </span>
      </div>
      {props.outlineItems.map((item) => (
        <div
          key={item.id}
          className="flex cursor-pointer items-center gap-2 rounded-[10px] px-2 py-1.5 transition-colors hover:bg-hover"
          onClick={props.onSelectOutline}
        >
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              item.status === "done" ? "bg-accent" : "bg-black/15"
            }`}
          />
          <span
            className={`truncate text-[13px] ${
              item.status === "done" ? "text-muted line-through" : "text-body"
            }`}
          >
            {item.title}
          </span>
        </div>
      ))}
    </>
  );
}

function ChapterList(props: SidebarProps) {
  if (props.chapters.length === 0) {
    return <p className="px-1 py-2 text-xs text-muted">还没有章节</p>;
  }
  return (
    <>
      {props.chapters.map((c) => {
        const active = c.id === props.currentChapterId;
        return (
          <div
            key={c.id}
            className={`group flex items-center rounded-[10px] px-2 py-1.5 transition-colors ${
              active ? "bg-surface shadow-card" : "hover:bg-hover"
            }`}
          >
            <button
              className="min-w-0 flex-1 text-left"
              onClick={() => props.onSelectChapter(c.id)}
            >
              <div
                className={`truncate text-[13px] ${
                  active ? "font-semibold text-ink" : "text-body"
                }`}
              >
                {c.title}
              </div>
              <div className="mt-px text-[11px] text-faint">
                {c.word_count} 字
              </div>
            </button>
            <button
              title="删除章节"
              className="ml-1 hidden text-faint group-hover:block hover:text-pred-t"
              onClick={() => props.onDeleteChapter(c.id)}
            >
              ×
            </button>
          </div>
        );
      })}
    </>
  );
}

function LoreList(props: SidebarProps) {
  if (props.loreEntries.length === 0) {
    return (
      <p className="px-1 py-2 text-xs leading-5 text-muted">
        还没有设定。建一张人物卡试试：填入角色名作为关键词，AI 续写时会自动带上。
      </p>
    );
  }
  return (
    <>
      {props.loreEntries.map((e) => {
        const active = e.id === props.currentLoreId;
        return (
          <div
            key={e.id}
            className={`group flex items-center rounded-[10px] px-2 py-1.5 transition-colors ${
              active ? "bg-surface shadow-card" : "hover:bg-hover"
            } ${e.enabled ? "" : "opacity-50"}`}
          >
            <button
              className="min-w-0 flex-1 text-left"
              onClick={() => props.onSelectLore(e.id)}
            >
              <div className="flex items-center gap-1.5 truncate text-[13px]">
                <span
                  className={`truncate ${
                    active ? "font-semibold text-ink" : "text-body"
                  }`}
                >
                  {e.title}
                </span>
                {e.always_include && (
                  <span
                    className="shrink-0 rounded-full bg-accent-soft px-1.5 py-px text-[10px] font-medium text-accent"
                    title="常驻注入"
                  >
                    常驻
                  </span>
                )}
              </div>
              <div className="mt-px text-[11px] text-faint">{e.category}</div>
            </button>
            <button
              title="删除词条"
              className="ml-1 hidden text-faint group-hover:block hover:text-pred-t"
              onClick={() => props.onDeleteLore(e.id)}
            >
              ×
            </button>
          </div>
        );
      })}
    </>
  );
}
