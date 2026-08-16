import { api } from "../lib/api";
import type { Project, Task } from "../types";

interface TasksViewProps {
  tasks: Task[];
  projects: Project[];
  onChanged: () => void;
  onToast: (msg: string) => void;
}

const KIND_LABEL: Record<string, string> = {
  batch_chapters: "批量写章",
  video_shots: "镜头视频",
  rewrite_chapters: "跨章改写",
};

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  pending: { label: "排队中", cls: "bg-pyellow text-pyellow-t" },
  running: { label: "进行中", cls: "bg-accent-soft text-accent" },
  paused: { label: "待继续", cls: "bg-pyellow text-pyellow-t" },
  done: { label: "完成", cls: "bg-pgreen text-pgreen-t" },
  error: { label: "失败", cls: "bg-pred text-pred-t" },
  cancelled: { label: "已取消", cls: "bg-track text-muted" },
};

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 任务面板：所有长任务（批量写章/镜头视频等）的队列与历史 */
export function TasksView({ tasks, projects, onChanged, onToast }: TasksViewProps) {
  const projectName = (id: number) =>
    projects.find((p) => p.id === id)?.name ?? "";

  const act = async (fn: () => Promise<unknown>, okMsg?: string) => {
    try {
      await fn();
      if (okMsg) onToast(okMsg);
      onChanged();
    } catch (e) {
      onToast(String(e));
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-10 pt-10 pb-16">
        <div className="flex items-center gap-3.5">
          <h1 className="text-[26px] font-bold tracking-tight text-ink">任务</h1>
          <span className="text-xs text-muted">
            {tasks.filter((t) => t.status === "running" || t.status === "pending").length}{" "}
            个进行中
          </span>
          {tasks.some((t) => ["done", "error", "cancelled"].includes(t.status)) && (
            <button
              className="ml-auto rounded-full bg-card/70 px-3.5 py-1.5 text-xs text-body shadow-card transition-colors hover:bg-surface"
              onClick={() =>
                void act(() => api.clearFinishedTasks(), "已清理完结任务")
              }
            >
              清理已完成
            </button>
          )}
        </div>
        <p className="mt-1.5 text-xs leading-5 text-muted">
          长任务统一在这里排队执行（串行），关掉页面任务照跑
        </p>

        <div className="mt-6 flex flex-col gap-2.5">
          {tasks.map((t) => {
            const st = STATUS_STYLE[t.status] ?? STATUS_STYLE.done;
            const active = t.status === "running" || t.status === "pending";
            return (
              <div
                key={t.id}
                className="rounded-2xl bg-surface px-5 py-4 shadow-card"
              >
                <div className="flex items-center gap-2.5">
                  <span className="rounded-full bg-canvas px-2 py-0.5 text-[10px] text-muted">
                    {KIND_LABEL[t.kind] ?? t.kind}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
                    {t.label}
                  </span>
                  <span className={`rounded-full px-2.5 py-1 text-[11px] ${st.cls}`}>
                    {st.label}
                  </span>
                  {active ? (
                    <button
                      className="rounded-full bg-card/70 px-3 py-1.5 text-xs text-pred-t shadow-card transition-colors hover:bg-surface"
                      onClick={() => void act(() => api.cancelTask(t.id))}
                    >
                      取消
                    </button>
                  ) : (
                    <>
                      {t.status === "paused" && (
                        <button
                          className="rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h"
                          onClick={() =>
                            void act(() => api.resumeTask(t.id), "已继续")
                          }
                        >
                          继续
                        </button>
                      )}
                      {t.kind === "rewrite_chapters" && t.status === "done" && (
                        <button
                          className="rounded-full bg-card/70 px-3 py-1.5 text-xs text-pyellow-t shadow-card transition-colors hover:bg-surface"
                          onClick={() =>
                            void act(
                              () => api.rollbackRewriteTask(t.id),
                              "已回滚到改写前状态"
                            )
                          }
                        >
                          回滚
                        </button>
                      )}
                      {t.status !== "paused" && (
                        <button
                          className="rounded-full bg-card/70 px-3 py-1.5 text-xs text-body shadow-card transition-colors hover:bg-surface"
                          onClick={() =>
                            void act(() => api.retryTask(t.id), "已重新入队")
                          }
                        >
                          重试
                        </button>
                      )}
                    </>
                  )}
                </div>
                {t.status === "running" && (
                  <div className="mt-2.5">
                    <div className="flex justify-between text-[11px] text-muted">
                      <span className="truncate">{t.progress_label}</span>
                      <span>
                        {t.progress_current}/{t.progress_total}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-track">
                      <div
                        className="h-full rounded-full bg-accent transition-all"
                        style={{
                          width: `${
                            t.progress_total === 0
                              ? 5
                              : (t.progress_current / t.progress_total) * 100
                          }%`,
                        }}
                      />
                    </div>
                  </div>
                )}
                <div className="mt-1.5 flex items-center gap-2 text-[11px] text-faint">
                  <span>{projectName(t.project_id)}</span>
                  <span>·</span>
                  <span>{fmtTime(t.created_at)}</span>
                  {t.result && (
                    <>
                      <span>·</span>
                      <span>{t.result}</span>
                    </>
                  )}
                </div>
                {t.status === "error" && t.error && (
                  <p className="mt-2 rounded-xl bg-pred px-3 py-2 text-xs leading-5 text-pred-t">
                    {t.error}
                  </p>
                )}
              </div>
            );
          })}
          {tasks.length === 0 && (
            <p className="py-10 text-center text-[13px] text-faint">
              还没有任务——批量写章、镜头视频生成都会出现在这里
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
