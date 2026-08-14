import { useState } from "react";
import { api } from "../lib/api";
import type { ChapterMeta } from "../types";

interface PublishViewProps {
  chapters: ChapterMeta[];
}

/**
 * 发布到番茄小说：fill-only 半自动。
 * 程序只负责把章节填进作家后台的编辑页，发布按钮永远人工点。
 * 流程：打开后台窗口扫码登录 → 进入作品的新建章节页 → 回来逐章填充 → 到后台核对发布。
 */
export function PublishView({ chapters }: PublishViewProps) {
  const [windowOpened, setWindowOpened] = useState(false);
  const [fillingId, setFillingId] = useState<number | null>(null);
  const [filled, setFilled] = useState<Set<number>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openWindow = async () => {
    setError(null);
    try {
      await api.openFanqieWindow();
      setWindowOpened(true);
    } catch (e) {
      setError(String(e));
    }
  };

  const fill = async (id: number) => {
    if (fillingId != null) return;
    setFillingId(id);
    setError(null);
    setMessage(null);
    try {
      const msg = await api.fillChapterDraft(id);
      setFilled((prev) => new Set(prev).add(id));
      setMessage(msg);
    } catch (e) {
      setError(String(e));
    } finally {
      setFillingId(null);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-10 pt-10 pb-16">
        <h1 className="text-[26px] font-bold tracking-tight text-ink">发布</h1>
        <p className="mt-1.5 text-xs leading-5 text-muted">
          把章节一键填进番茄作家后台，核对后由你手动点发布。请遵守平台规则
          （每日发布字数上限、AI 内容申报等），后果由账号自行承担。
        </p>

        {/* 操作引导 */}
        <div className="mt-6 rounded-2xl bg-surface p-5 shadow-card">
          <div className="flex items-center gap-3">
            <button
              onClick={() => void openWindow()}
              className="rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h"
            >
              {windowOpened ? "聚焦后台窗口" : "打开番茄作家后台"}
            </button>
            <span className="text-[11px] leading-4 text-faint">
              首次使用需在弹出窗口扫码登录，登录态会保留
            </span>
          </div>
          <ol className="mt-4 list-decimal space-y-1 pl-5 text-[13px] leading-6 text-body">
            <li>点上面按钮打开后台窗口，扫码登录</li>
            <li>
              在后台进入对应作品，打开<b>「新建章节」编辑页</b>（停在这一页）
            </li>
            <li>回到这里，点章节右侧的「填充到后台」</li>
            <li>切回后台窗口核对内容，手动点发布（或存草稿）</li>
            <li>发布下一章：后台重新打开新建章节页，再回来填充</li>
          </ol>
        </div>

        {(message || error) && (
          <p
            className={`mt-4 rounded-xl px-3.5 py-2.5 text-xs leading-5 ${
              error ? "bg-pred text-pred-t" : "bg-pgreen text-pgreen-t"
            }`}
          >
            {error ?? message}
          </p>
        )}

        {/* 章节列表 */}
        <div className="mt-6 flex flex-col gap-2">
          {chapters.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-3 rounded-2xl bg-surface px-5 py-3.5 shadow-card"
            >
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
                {c.title}
              </span>
              <span className="text-[11px] text-faint">{c.word_count} 字</span>
              {filled.has(c.id) && (
                <span className="rounded-full bg-pgreen px-2.5 py-1 text-[11px] text-pgreen-t">
                  已填充
                </span>
              )}
              <button
                disabled={fillingId != null || c.word_count === 0}
                title={c.word_count === 0 ? "章节还没有内容" : undefined}
                onClick={() => void fill(c.id)}
                className="shrink-0 rounded-full bg-white/70 px-3.5 py-1.5 text-xs text-body shadow-card transition-colors hover:bg-surface disabled:opacity-40"
              >
                {fillingId === c.id ? "填充中…" : "填充到后台"}
              </button>
            </div>
          ))}
          {chapters.length === 0 && (
            <p className="py-10 text-center text-[13px] text-faint">
              还没有章节，先去写作页创作
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
