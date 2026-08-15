import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ChapterMeta, Video } from "../types";

interface PublishViewProps {
  projectId: number;
  chapters: ChapterMeta[];
}

/**
 * 发布页：fill-only 半自动。程序只负责填内容，发布按钮永远人工点。
 * 小说章节 → 番茄作家后台；推文视频 → 抖音创作者中心（红果短剧无个人上传通道）。
 */
export function PublishView({ projectId, chapters }: PublishViewProps) {
  const [windowOpened, setWindowOpened] = useState(false);
  const [douyinOpened, setDouyinOpened] = useState(false);
  const [fillingId, setFillingId] = useState<number | null>(null);
  const [filled, setFilled] = useState<Set<number>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);

  useEffect(() => {
    void api
      .listVideos(projectId)
      .then((vs) => setVideos(vs.filter((v) => v.status === "done" && v.output_path)))
      .catch(console.error);
  }, [projectId]);

  const openWindow = async () => {
    setError(null);
    try {
      await api.openFanqieWindow();
      setWindowOpened(true);
    } catch (e) {
      setError(String(e));
    }
  };

  const openDouyin = async () => {
    setError(null);
    try {
      await api.openDouyinWindow();
      setDouyinOpened(true);
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

  const fillCaption = async (id: number) => {
    if (fillingId != null) return;
    setFillingId(-id); // 与章节填充共用互斥锁，负数区分视频
    setError(null);
    setMessage(null);
    try {
      const msg = await api.fillDouyinCaption(id);
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
          程序只负责把内容填进平台后台，核对后由你手动点发布。请遵守平台规则
          （字数上限、AI 内容申报等），后果由账号自行承担。
        </p>

        {(message || error) && (
          <p
            className={`mt-4 rounded-xl px-3.5 py-2.5 text-xs leading-5 ${
              error ? "bg-pred text-pred-t" : "bg-pgreen text-pgreen-t"
            }`}
          >
            {error ?? message}
          </p>
        )}

        {/* 小说章节 → 番茄 */}
        <div className="mt-6 rounded-2xl bg-surface p-5 shadow-card">
          <div className="flex items-center gap-3">
            <h2 className="text-[15px] font-bold text-ink">小说章节 → 番茄作家后台</h2>
            <button
              onClick={() => void openWindow()}
              className="ml-auto rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h"
            >
              {windowOpened ? "聚焦后台窗口" : "打开番茄作家后台"}
            </button>
          </div>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-[13px] leading-6 text-body">
            <li>点上面按钮打开后台窗口，扫码登录（登录态会保留）</li>
            <li>
              在后台进入对应作品，打开<b>「新建章节」编辑页</b>（停在这一页）
            </li>
            <li>回到这里，点章节右侧的「填充到后台」</li>
            <li>切回后台窗口核对内容，手动点发布（或存草稿）</li>
          </ol>

          <div className="mt-4 flex flex-col gap-2">
            {chapters.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-3 rounded-xl bg-canvas px-4 py-2.5"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
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
                  className="shrink-0 rounded-full bg-white/80 px-3.5 py-1.5 text-xs text-body shadow-card transition-colors hover:bg-surface disabled:opacity-40"
                >
                  {fillingId === c.id ? "填充中…" : "填充到后台"}
                </button>
              </div>
            ))}
            {chapters.length === 0 && (
              <p className="py-4 text-center text-[13px] text-faint">
                还没有章节，先去写作页创作
              </p>
            )}
          </div>
        </div>

        {/* 推文视频 → 抖音 */}
        <div className="mt-6 rounded-2xl bg-surface p-5 shadow-card">
          <div className="flex items-center gap-3">
            <h2 className="text-[15px] font-bold text-ink">推文视频 → 抖音</h2>
            <button
              onClick={() => void openDouyin()}
              className="ml-auto rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h"
            >
              {douyinOpened ? "聚焦抖音窗口" : "打开抖音创作者中心"}
            </button>
          </div>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-[13px] leading-6 text-body">
            <li>打开抖音窗口并扫码登录（创作者中心上传页）</li>
            <li>把成片 mp4 拖进上传区（点「打开文件夹」取文件）</li>
            <li>上传完成后点「填充文案」——标题和话题标签自动填好</li>
            <li>核对后手动发布；接任务/回填链接去番茄达人中心（kol.fanqieopen.com）</li>
          </ol>

          <div className="mt-4 flex flex-col gap-2">
            {videos.map((v) => (
              <div
                key={v.id}
                className="flex items-center gap-3 rounded-xl bg-canvas px-4 py-2.5"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                  {v.title}
                </span>
                <button
                  onClick={() => void api.openVideoFolder(v.id)}
                  className="shrink-0 rounded-full bg-white/80 px-3 py-1.5 text-xs text-body shadow-card transition-colors hover:bg-surface"
                >
                  打开文件夹
                </button>
                <button
                  disabled={fillingId != null}
                  onClick={() => void fillCaption(v.id)}
                  className="shrink-0 rounded-full bg-white/80 px-3.5 py-1.5 text-xs text-body shadow-card transition-colors hover:bg-surface disabled:opacity-40"
                >
                  {fillingId === -v.id ? "填充中…" : "填充文案"}
                </button>
              </div>
            ))}
            {videos.length === 0 && (
              <p className="py-4 text-center text-[13px] text-faint">
                还没有成片——到「视频」工坊合成一条再来
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
