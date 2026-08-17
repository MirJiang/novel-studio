import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { ChapterMeta, LoreChange } from "../types";

interface LoreLedgerViewProps {
  projectId: number;
  chapters: ChapterMeta[];
  /** 当前打开的章节（「提取本章变更」按钮用） */
  currentChapterId: number | null;
}

const KIND_META: Record<string, { label: string; cls: string }> = {
  new: { label: "登场", cls: "bg-pgreen text-pgreen-t" },
  update: { label: "变更", cls: "bg-pyellow text-pyellow-t" },
  retire: { label: "退场", cls: "bg-pred text-pred-t" },
};

/**
 * 设定变更台账：按章分组展示 AI 提取的设定状态变化（只读，无审核流）。
 * 自动：摘要生成/批量补齐/批量写章时顺带提取；手动：下方按钮按章提取或全部补齐。
 * 重复提取同章会整章替换，幂等。
 */
export function LoreLedgerView({
  projectId,
  chapters,
  currentChapterId,
}: LoreLedgerViewProps) {
  const [changes, setChanges] = useState<LoreChange[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setChanges(await api.listLoreChanges(projectId));
    } catch (e) {
      console.error(e);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 手动提取单章（重复提取幂等：整章替换） */
  const extractOne = async (chapterId: number) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const n = await api.extractLoreChanges(chapterId);
      setInfo(n > 0 ? `本章提取到 ${n} 条变更` : "本章没有持久的设定变更");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 补齐全部章节（逐章顺序提取，前端带进度） */
  const extractAll = async () => {
    if (busy) return;
    const targets = chapters.filter((c) => c.word_count > 0);
    if (targets.length === 0) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    let done = 0;
    try {
      for (const c of targets) {
        setProgress(`提取中 ${done + 1}/${targets.length}：${c.title}`);
        try {
          await api.extractLoreChanges(c.id);
        } catch (e) {
          console.error(`《${c.title}》提取失败`, e);
        }
        done += 1;
      }
      setInfo(`补齐完成，共处理 ${done} 章`);
      await refresh();
    } finally {
      setProgress(null);
      setBusy(false);
    }
  };

  /** 按章分组（列表本身已按章节序号倒序，直接切连续段） */
  const groups = useMemo(() => {
    const out: { chapterId: number; title: string; rows: LoreChange[] }[] = [];
    for (const c of changes) {
      const last = out[out.length - 1];
      if (last && last.chapterId === c.chapter_id) {
        last.rows.push(c);
      } else {
        out.push({ chapterId: c.chapter_id, title: c.chapter_title, rows: [c] });
      }
    }
    return out;
  }, [changes]);

  const coveredChapters = useMemo(
    () => new Set(changes.map((c) => c.chapter_id)).size,
    [changes],
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[760px] px-8 py-6">
        <div className="flex items-center gap-3">
          <h1 className="text-[20px] font-bold tracking-tight text-ink">
            设定变更台账
          </h1>
          <span className="text-xs text-muted">
            {changes.length} 条变更 · 覆盖 {coveredChapters} 章
          </span>
          <div className="ml-auto flex gap-2">
            <button
              disabled={busy || currentChapterId == null}
              title={
                currentChapterId == null
                  ? "先在侧栏打开一章"
                  : "提取当前打开章节的设定变更"
              }
              onClick={() => currentChapterId != null && void extractOne(currentChapterId)}
              className="rounded-full bg-card/70 px-3.5 py-1.5 text-[13px] text-body shadow-card transition-colors hover:bg-surface disabled:opacity-40"
            >
              提取本章变更
            </button>
            <button
              disabled={busy || chapters.length === 0}
              onClick={() => void extractAll()}
              className="rounded-full bg-accent px-4 py-1.5 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
            >
              补齐全部章节
            </button>
          </div>
        </div>
        <p className="mt-1.5 text-xs leading-5 text-muted">
          每章对设定造成的持久变化（物品得失、地图解锁、境界提升、关系/状态转变），AI
          自动提取——生成摘要、批量补齐、批量写章时都会顺带跑；也可手动按章提取。只读查看，不会改动设定库。
        </p>

        {progress && (
          <p className="mt-3 rounded-xl bg-accent-soft px-3.5 py-2.5 text-xs text-accent">
            {progress}
          </p>
        )}
        {info && !progress && (
          <p className="mt-3 rounded-xl bg-pgreen px-3.5 py-2.5 text-xs text-pgreen-t">
            {info}
          </p>
        )}
        {error && (
          <p className="mt-3 rounded-xl bg-pred px-3.5 py-2.5 text-xs leading-5 text-pred-t">
            {error}
          </p>
        )}

        {groups.length === 0 ? (
          <p className="py-16 text-center text-[13px] leading-6 text-faint">
            还没有变更记录。
            <br />
            生成/补齐章节摘要时会自动提取；也可以点右上角手动提取。
          </p>
        ) : (
          <div className="mt-4 flex flex-col gap-3 pb-10">
            {groups.map((g) => (
              <section
                key={g.chapterId}
                className="rounded-2xl bg-surface p-4 shadow-card"
              >
                <p className="text-[13px] font-semibold text-ink">{g.title}</p>
                <div className="mt-2 flex flex-col gap-1.5">
                  {g.rows.map((r) => {
                    const meta = KIND_META[r.kind] ?? KIND_META.update;
                    return (
                      <div
                        key={r.id}
                        className="flex items-baseline gap-2 rounded-xl bg-canvas px-3 py-2"
                      >
                        <span
                          className={`shrink-0 rounded-full px-2 py-px text-[10px] font-medium ${meta.cls}`}
                        >
                          {meta.label}
                        </span>
                        <span className="shrink-0 rounded-full bg-track px-2 py-px text-[10px] text-muted">
                          {r.category}
                        </span>
                        <span className="shrink-0 text-[12px] font-semibold text-ink">
                          {r.entry_title}
                        </span>
                        <span className="min-w-0 text-[12px] leading-5 text-body">
                          {r.detail}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
