import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import type { ChapterMeta, OutlineItem, Project } from "../types";

interface OutlineViewProps {
  project: Project;
  onProjectChanged: () => void;
}

/**
 * 大纲视图：作品简介（番茄风卖点）+ 分卷大纲（进度管控）。
 * 大纲会注入 AI 续写 prompt，让模型知道当前进度与走向。
 */
export function OutlineView({ project, onProjectChanged }: OutlineViewProps) {
  // 简介
  const [synopsis, setSynopsis] = useState(project.synopsis);
  const [description, setDescription] = useState(project.description);
  const [synopsisBusy, setSynopsisBusy] = useState(false);
  const saveTimer = useRef<number | null>(null);

  // 大纲
  const [items, setItems] = useState<OutlineItem[]>([]);
  const [outlineBusy, setOutlineBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 各卷已写章数（进度按章显示用）
  const [chapters, setChapters] = useState<ChapterMeta[]>([]);

  const refresh = useCallback(async () => {
    try {
      setItems(await api.listOutline(project.id));
      setChapters(await api.listChapters(project.id));
    } catch (e) {
      console.error(e);
    }
  }, [project.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 各卷已写章数（outline_item_id → 章数） */
  const writtenByVolume = useMemo(() => {
    const m = new Map<number, number>();
    for (const c of chapters) {
      m.set(c.outline_item_id, (m.get(c.outline_item_id) ?? 0) + 1);
    }
    return m;
  }, [chapters]);

  // 简介/标签 防抖保存
  const scheduleSaveInfo = (desc: string, syn: string) => {
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void api.saveProjectInfo(project.id, desc, syn).then(onProjectChanged);
    }, 800);
  };

  const runSynopsis = async () => {
    if (synopsisBusy) return;
    setSynopsisBusy(true);
    setError(null);
    try {
      const text = await api.generateSynopsis(project.id);
      setSynopsis(text);
      onProjectChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setSynopsisBusy(false);
    }
  };

  const runOutline = async () => {
    if (outlineBusy) return;
    if (
      items.length > 0 &&
      !window.confirm("重新生成会替换现有大纲节点，确定继续吗？")
    ) {
      return;
    }
    setOutlineBusy(true);
    setError(null);
    try {
      setItems(await api.generateOutline(project.id));
    } catch (e) {
      setError(String(e));
    } finally {
      setOutlineBusy(false);
    }
  };

  const done = items.filter((i) => i.status === "done").length;
  const totalTarget = items.reduce((s, i) => s + i.target_chapters, 0);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[680px] px-8 pt-6 pb-20">
        {/* 作品简介 */}
        <section className="rounded-2xl bg-surface p-5 shadow-card">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">作品简介</h3>
            <button
              disabled={synopsisBusy}
              onClick={() => void runSynopsis()}
              className="rounded-full bg-accent px-3 py-1 text-[11px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
            >
              {synopsisBusy ? "生成中…" : synopsis ? "AI 重写" : "AI 生成简介"}
            </button>
          </div>
          <input
            className="mt-3 w-full rounded-[10px] bg-canvas px-3 py-1.5 text-xs text-body outline-none placeholder:text-faint focus:bg-surface2"
            placeholder="题材短标签（书架卡片显示），如：都市 · 系统流"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              scheduleSaveInfo(e.target.value, synopsis);
            }}
          />
          <textarea
            className="mt-2 h-32 w-full resize-none rounded-[10px] bg-canvas p-3 text-[13px] leading-6 text-body outline-none placeholder:text-faint focus:bg-surface2"
            placeholder="番茄风作品简介：第一句就是钩子，点出金手指与最大看点，结尾抛悬念…"
            value={synopsis}
            onChange={(e) => {
              setSynopsis(e.target.value);
              scheduleSaveInfo(description, e.target.value);
            }}
          />
          <p className="mt-1 text-[11px] text-faint">修改自动保存</p>
        </section>

        {/* 分卷大纲 */}
        <section className="mt-5 rounded-2xl bg-surface p-5 shadow-card">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">分卷大纲</h3>
            <div className="flex items-center gap-2">
              <button
                onClick={() =>
                  void api
                    .addOutlineItem(project.id, `节点 ${items.length + 1}`)
                    .then(refresh)
                }
                className="rounded-full bg-card/70 px-3 py-1 text-[11px] text-body shadow-card transition-colors hover:bg-hover"
              >
                ＋ 加节点
              </button>
              <button
                disabled={outlineBusy}
                onClick={() => void runOutline()}
                className="rounded-full bg-accent px-3 py-1 text-[11px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
              >
                {outlineBusy
                  ? "生成中…"
                  : items.length > 0
                    ? "AI 重新生成"
                    : "AI 生成大纲"}
              </button>
            </div>
          </div>

          {/* 进度条 */}
          {items.length > 0 && (
            <div className="mt-3 flex items-center gap-3">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-track">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{
                    width: `${items.length === 0 ? 0 : (done / items.length) * 100}%`,
                  }}
                />
              </div>
              <span className="text-[11px] text-muted">
                {done}/{items.length} 节点
                {totalTarget > 0 &&
                  ` · ${chapters.length} 章 / 全书预估约 ${totalTarget} 章`}
              </span>
            </div>
          )}

          <div className="mt-3 flex flex-col gap-2.5">
            {items.length === 0 && (
              <p className="py-3 text-center text-xs text-faint">
                还没有大纲。点「AI 生成大纲」按简介和设定产出分卷节点
              </p>
            )}
            {items.map((item, i) => (
              <OutlineCard
                key={item.id}
                item={item}
                written={writtenByVolume.get(item.id) ?? 0}
                current={item.status !== "done" && done === i}
                onChanged={refresh}
              />
            ))}
          </div>
        </section>

        {error && (
          <p className="mt-4 rounded-xl bg-pred px-3.5 py-2.5 text-xs leading-5 text-pred-t">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function OutlineCard({
  item,
  written,
  current,
  onChanged,
}: {
  item: OutlineItem;
  /** 本卷已写章数 */
  written: number;
  /** 首个未完成节点 = 当前进度 */
  current: boolean;
  onChanged: () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [content, setContent] = useState(item.content);
  const [target, setTarget] = useState(String(item.target_chapters || ""));
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setTitle(item.title);
    setContent(item.content);
    setTarget(String(item.target_chapters || ""));
  }, [item.id, item.title, item.content, item.target_chapters]);

  const scheduleSave = (t: string, c: string, tc: string) => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void api.saveOutlineItem(item.id, t, c, parseInt(tc, 10) || 0);
    }, 800);
  };

  const isDone = item.status === "done";

  return (
    <div
      className={`rounded-xl p-3 transition-colors ${
        current ? "bg-accent-soft" : "bg-canvas"
      }`}
    >
      <div className="flex items-center gap-2">
        <button
          title={isDone ? "标记为未完成" : "标记为已完成"}
          onClick={() =>
            void api
              .setOutlineStatus(item.id, isDone ? "planned" : "done")
              .then(onChanged)
          }
          className={`flex shrink-0 items-center justify-center rounded-full text-[10px] transition-colors ${
            isDone
              ? "bg-accent text-white"
              : "bg-black/10 text-transparent hover:bg-black/20"
          }`}
          style={{ height: 18, width: 18 }}
        >
          ✓
        </button>
        <input
          className={`min-w-0 flex-1 bg-transparent text-[13px] font-medium outline-none ${
            isDone ? "text-muted line-through" : "text-ink"
          }`}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            scheduleSave(e.target.value, content, target);
          }}
        />
        <span
          className="flex shrink-0 items-center gap-1 text-[11px] text-faint"
          title="本卷预估章数：AI 生成大纲时按剧情体量估，可手改；收卷判定的下限依据"
        >
          约
          <input
            className="w-12 rounded-md bg-card/70 px-1.5 py-0.5 text-center text-[11px] text-body outline-none focus:bg-surface"
            placeholder="—"
            inputMode="numeric"
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              scheduleSave(title, content, e.target.value);
            }}
          />
          章
        </span>
        {current && (
          <span className="shrink-0 rounded-full bg-accent px-2 py-px text-[10px] font-medium text-white">
            当前进度
          </span>
        )}
        <button
          title="删除节点"
          className="shrink-0 text-faint hover:text-pred-t"
          onClick={() => void api.deleteOutlineItem(item.id).then(onChanged)}
        >
          ×
        </button>
      </div>
      <textarea
        className="mt-2 h-16 w-full resize-none rounded-lg bg-card/70 p-2 text-xs leading-5 text-body outline-none placeholder:text-faint focus:bg-surface"
        placeholder="本卷主线与关键转折…"
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          scheduleSave(title, e.target.value, target);
        }}
      />
      <p className="mt-1.5 text-[11px] text-faint">
        已写 {written} 章
        {item.target_chapters > 0 && ` / 约 ${item.target_chapters} 章`}
        {item.target_chapters > 0 &&
          written * 5 < item.target_chapters * 3 &&
          "（未到预估六成，不会自动收卷）"}
      </p>
    </div>
  );
}
