import { useMemo, useState } from "react";
import type { ChapterMeta, Project, Task } from "../types";

export interface BatchStartOptions {
  /** <=0 表示写完整本书 */
  chapterCount: number;
  wordsPerChapter: number;
  /** 要持久化到作品上的字数目标 */
  totalWords: number;
  chapterWords: number;
}

interface BatchWriteDialogProps {
  project: Project;
  chapters: ChapterMeta[];
  /** 本作品进行中/排队中的批量写章任务（来自任务队列轮询） */
  batch: Task | null;
  onStart: (opts: BatchStartOptions) => void;
  /** 最小化（任务在队列里继续跑） */
  onMinimize: () => void;
  /** 取消任务（当前章写完后停下，已写章节保留） */
  onCancel: (taskId: number) => void;
  onClose: () => void;
}

function parseWords(s: string): number {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 实测一章正文+摘要约 45 秒 */
const SECONDS_PER_CHAPTER = 45;

function fmtDuration(chapters: number): string {
  const mins = Math.round((chapters * SECONDS_PER_CHAPTER) / 60);
  if (mins >= 60) return `约 ${Math.floor(mins / 60)} 小时 ${mins % 60} 分钟`;
  return `约 ${Math.max(mins, 1)} 分钟`;
}

/**
 * 批量写章弹层：入队到任务队列，后端 worker 串行执行、逐章落库。
 * 进度来自 App 层的任务轮询——弹层关掉任务照跑，任务面板里也能看到。
 */
export function BatchWriteDialog({
  project,
  chapters,
  batch,
  onStart,
  onMinimize,
  onCancel,
  onClose,
}: BatchWriteDialogProps) {
  const [totalWords, setTotalWords] = useState(
    project.target_total_words > 0 ? String(project.target_total_words) : ""
  );
  const [chapterWords, setChapterWords] = useState(
    project.target_chapter_words > 0 ? String(project.target_chapter_words) : "2000"
  );
  const [count, setCount] = useState("3");

  const running = batch != null;
  const queued = batch?.status === "pending";

  const written = useMemo(
    () => chapters.reduce((sum, c) => sum + c.word_count, 0),
    [chapters]
  );
  const target = parseWords(totalWords);
  const wpc = parseWords(chapterWords) || 2000;
  const remainingChapters =
    target > written ? Math.ceil((target - written) / wpc) : 0;

  const start = (wholeBook: boolean) => {
    onStart({
      chapterCount: wholeBook ? 0 : Math.max(parseWords(count) || 1, 1),
      wordsPerChapter: wpc,
      totalWords: parseWords(totalWords),
      chapterWords: parseWords(chapterWords),
    });
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/25 backdrop-blur-sm">
      <div className="w-[420px] rounded-2xl bg-surface p-6 shadow-float">
        <div className="flex items-center">
          <h2 className="text-[17px] font-bold text-ink">批量写章</h2>
          <button
            className="ml-auto text-faint hover:text-body"
            title={running ? "最小化到后台" : "关闭"}
            onClick={running ? onMinimize : onClose}
          >
            ✕
          </button>
        </div>
        <p className="mt-1 text-xs text-muted">
          《{project.name}》· 从最后一章往后连续创作，每章写完自动入库并生成摘要
        </p>

        <div className="mt-5 grid grid-cols-[88px_1fr] items-center gap-x-3 gap-y-3">
          <span className="text-xs text-muted">全书目标</span>
          <div className="flex items-center gap-2">
            <input
              disabled={running}
              className="w-32 rounded-[10px] bg-canvas px-3 py-2 text-[13px] text-body outline-none placeholder:text-faint focus:bg-surface2 disabled:opacity-50"
              placeholder="如 200000"
              inputMode="numeric"
              value={totalWords}
              onChange={(e) => setTotalWords(e.target.value)}
            />
            <span className="text-[11px] text-faint">
              已写 {written.toLocaleString()} 字
              {target > 0 &&
                (remainingChapters > 0
                  ? ` · 约还需 ${remainingChapters} 章`
                  : " · 已达标")}
            </span>
          </div>
          <span className="text-xs text-muted">每章字数</span>
          <input
            disabled={running}
            className="w-32 rounded-[10px] bg-canvas px-3 py-2 text-[13px] text-body outline-none placeholder:text-faint focus:bg-surface2 disabled:opacity-50"
            placeholder="如 2000"
            inputMode="numeric"
            value={chapterWords}
            onChange={(e) => setChapterWords(e.target.value)}
          />
          <span className="text-xs text-muted">生成章数</span>
          <input
            disabled={running}
            className="w-32 rounded-[10px] bg-canvas px-3 py-2 text-[13px] text-body outline-none placeholder:text-faint focus:bg-surface2 disabled:opacity-50"
            placeholder="不封顶"
            inputMode="numeric"
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
        </div>

        {batch && (
          <div className="mt-4">
            <div className="flex justify-between text-xs text-muted">
              <span className="truncate">
                {queued ? "排队中…" : `正在创作：${batch.progress_label}`}
              </span>
              <span>
                {batch.progress_current}/{batch.progress_total}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-track">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{
                  width: `${
                    batch.progress_total === 0
                      ? 5
                      : (batch.progress_current / batch.progress_total) * 100
                  }%`,
                }}
              />
            </div>
          </div>
        )}

        <div className="mt-5 flex items-center gap-2.5">
          {running ? (
            <>
              <button
                className="rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h"
                onClick={onMinimize}
              >
                后台运行，去做别的 →
              </button>
              <button
                className="rounded-full bg-card/70 px-4 py-2 text-[13px] text-pred-t shadow-card transition-colors hover:bg-surface"
                onClick={() => onCancel(batch.id)}
              >
                取消任务
              </button>
            </>
          ) : (
            <>
              <button
                className="rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
                onClick={() => start(false)}
              >
                开始生成 {Math.max(parseWords(count) || 1, 1)} 章
              </button>
              <button
                disabled={target <= 0 || remainingChapters <= 0}
                title={target <= 0 ? "先在上方填全书目标字数" : undefined}
                className="rounded-full bg-card/70 px-4 py-2 text-[13px] text-body shadow-card transition-colors hover:bg-surface disabled:opacity-40"
                onClick={() => start(true)}
              >
                写完整本书
              </button>
            </>
          )}
        </div>
        {!running && (
          <p className="mt-2 text-[11px] leading-4 text-faint">
            本次任务：按章数 = {Math.max(parseWords(count) || 1, 1)} 章 ·{" "}
            {(((Math.max(parseWords(count) || 1, 1)) * wpc) / 10000).toFixed(1)} 万字 ·{" "}
            {fmtDuration(Math.max(parseWords(count) || 1, 1))}
            {target > 0 && remainingChapters > 0 && (
              <>
                <br />
                写完整本书 = {remainingChapters} 章 ·{" "}
                {((remainingChapters * wpc) / 10000).toFixed(1)} 万字 ·{" "}
                {fmtDuration(remainingChapters)}
              </>
            )}
          </p>
        )}
        <p className="mt-2 text-[11px] text-faint">
          {running
            ? "任务在队列里后台执行，右下角可查看进度；取消会在当前章写完后停下，已写章节保留"
            : target <= 0
              ? "填了全书目标字数后，才能一键「写完整本书」"
              : "任务进队列后台执行，可在「任务」页查看全部进度"}
        </p>
      </div>
    </div>
  );
}
