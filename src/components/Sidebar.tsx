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
  /** 打开设定变更台账（主区整页） */
  onSelectLoreLedger: () => void;
  loreLedgerActive: boolean;
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
  const renderChapter = (c: ChapterMeta) => {
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
          <div className="mt-px text-[11px] text-faint">{c.word_count} 字</div>
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
  };

  if (props.chapters.length === 0) {
    return <p className="px-1 py-2 text-xs text-muted">还没有章节</p>;
  }

  // 无大纲：扁平列表（卷 = 大纲节点，没有大纲就没有卷）
  if (props.outlineItems.length === 0) {
    return <>{props.chapters.map(renderChapter)}</>;
  }

  // 按卷分组：未分卷（含大纲删节点后的悬挂章节）在最前，卷按大纲顺序；空卷也显示（写作路线图）
  const outlineIds = new Set(props.outlineItems.map((o) => o.id));
  const byVolume = new Map<number, ChapterMeta[]>();
  const loose: ChapterMeta[] = [];
  for (const c of props.chapters) {
    if (c.outline_item_id && outlineIds.has(c.outline_item_id)) {
      const arr = byVolume.get(c.outline_item_id) ?? [];
      arr.push(c);
      byVolume.set(c.outline_item_id, arr);
    } else {
      loose.push(c);
    }
  }
  const currentIdx = props.outlineItems.findIndex((o) => o.status !== "done");

  const volumeHeader = (label: string, chip: string | null, countText: string) => (
    <p className="flex items-center gap-1.5 px-2 pt-2.5 pb-1 text-[11px] font-semibold text-muted">
      <span className="truncate">{label}</span>
      {chip && (
        <span
          className={`shrink-0 rounded-full px-1.5 py-px text-[9px] ${
            chip === "已完成"
              ? "bg-pgreen text-pgreen-t"
              : "bg-accent-soft text-accent"
          }`}
        >
          {chip}
        </span>
      )}
      <span className="ml-auto shrink-0 font-normal text-faint">{countText}</span>
    </p>
  );

  return (
    <>
      {loose.length > 0 && (
        <>
          {volumeHeader("未分卷", null, `${loose.length} 章`)}
          {loose.map(renderChapter)}
        </>
      )}
      {props.outlineItems.map((o, i) => {
        const rows = byVolume.get(o.id) ?? [];
        const chip =
          // 第一个未完成卷的标记叫「当前卷」——不叫「进行中」，会和任务状态混淆
          o.status === "done" ? "已完成" : i === currentIdx ? "当前卷" : null;
        const countText =
          o.target_chapters > 0
            ? `${rows.length}/约${o.target_chapters} 章`
            : `${rows.length} 章`;
        return (
          <div key={o.id}>
            {volumeHeader(`第${i + 1}卷 · ${o.title}`, chip, countText)}
            {rows.map(renderChapter)}
          </div>
        );
      })}
    </>
  );
}

function LoreList(props: SidebarProps) {
  return (
    <>
      {/* 变更台账入口（主区整页，按章看设定变化） */}
      <button
        className={`mb-1 flex w-full items-center gap-1.5 rounded-[10px] px-2 py-1.5 text-left text-[13px] transition-colors ${
          props.loreLedgerActive
            ? "bg-surface font-semibold text-ink shadow-card"
            : "text-muted hover:bg-hover"
        }`}
        onClick={props.onSelectLoreLedger}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-3.5 w-3.5 shrink-0">
          <path d="M12 8v4l2.5 2.5" />
          <circle cx="12" cy="12" r="9" />
        </svg>
        变更台账
        <span className="ml-auto text-[10px] text-faint">按章看设定变化</span>
      </button>
      {props.loreEntries.length === 0 ? (
        <p className="px-1 py-2 text-xs leading-5 text-muted">
          还没有设定。建一张人物卡试试：填入角色名作为关键词，AI 续写时会自动带上。
        </p>
      ) : (
        props.loreEntries.map((e) => {
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
        })
      )}
    </>
  );
}
