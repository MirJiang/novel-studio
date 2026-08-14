import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { CheckReportMeta } from "../types";

interface CheckViewProps {
  projectId: number;
}

/**
 * 全书体检：基于 设定库 + 各章摘要，检查设定冲突/时间线/伏笔/逻辑。
 * 摘要覆盖度是体检质量的地基，所以提供"补齐摘要"入口。
 */
export function CheckView({ projectId }: CheckViewProps) {
  const [stats, setStats] = useState<[number, number] | null>(null);
  const [batchProgress, setBatchProgress] = useState<{
    current: number;
    total: number;
    label: string;
  } | null>(null);

  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [reportText, setReportText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [reports, setReports] = useState<CheckReportMeta[]>([]);
  const [viewingId, setViewingId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStats(await api.summaryStats(projectId));
      setReports(await api.listCheckReports(projectId));
    } catch (e) {
      console.error(e);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const [total, withSummary] = stats ?? [0, 0];
  const missing = total - withSummary;
  const busy = checking || batchProgress != null;

  // ---------- 批量补齐摘要 ----------

  const runBatchSummaries = async () => {
    setBatchProgress({ current: 0, total: missing, label: "准备中…" });
    setError(null);
    try {
      await api.generateMissingSummaries(projectId, (e) => {
        if (e.type === "progress") {
          setBatchProgress({
            current: e.current,
            total: e.total,
            label: e.label,
          });
        } else if (e.type === "error") {
          setError(e.message);
        } else if (e.type === "done") {
          setBatchProgress(null);
          void refresh();
        }
      });
    } catch (e) {
      setError(String(e));
      setBatchProgress(null);
      void refresh();
    }
  };

  // ---------- 体检 ----------

  const runCheck = async () => {
    setChecking(true);
    setError(null);
    setNote(null);
    setReportText("");
    setViewingId(null);
    let acc = "";
    try {
      await api.checkConsistency(projectId, (e) => {
        if (e.type === "meta") {
          setNote(e.note);
        } else if (e.type === "delta") {
          acc += e.text;
          setReportText(acc);
        } else if (e.type === "error") {
          setError(e.message);
        } else if (e.type === "done") {
          setChecking(false);
        }
      });
      // 报告存档
      if (acc.trim()) {
        const id = await api.saveCheckReport(projectId, acc);
        setViewingId(id);
        await refresh();
      }
    } catch (e) {
      setError(String(e));
      setChecking(false);
    }
  };

  const viewReport = async (id: number) => {
    setViewingId(id);
    setNote(null);
    setReportText(await api.getCheckReport(id));
  };

  return (
    <div className="flex min-h-0 flex-1">
      {/* 左：操作 + 历史 */}
      <div className="flex w-72 shrink-0 flex-col bg-white/45">
        <div className="p-5">
          <h2 className="font-display text-lg font-bold tracking-tight text-ink">
            全书体检
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted">
            检查设定冲突 / 时间线 / 伏笔台账 / 逻辑漏洞
          </p>

          <div className="mt-4 rounded-xl bg-white/60 px-3 py-2.5 text-xs text-body shadow-card">
            摘要覆盖：
            <span
              className={`font-medium ${
                missing > 0 ? "text-pyellow-t" : "text-pgreen-t"
              }`}
            >
              {withSummary}/{total} 章
            </span>
            {missing > 0 && (
              <span className="mt-1 block text-muted">
                体检只看有摘要的章节
              </span>
            )}
          </div>

          {missing > 0 && (
            <button
              disabled={busy}
              onClick={() => void runBatchSummaries()}
              className="mt-3 w-full rounded-full bg-white/70 px-3 py-1.5 text-sm text-body shadow-card transition-colors hover:bg-surface disabled:opacity-40"
            >
              补齐 {missing} 章摘要
            </button>
          )}

          <button
            disabled={busy || withSummary === 0}
            onClick={() => void runCheck()}
            className="mt-2 w-full rounded-full bg-accent px-3 py-1.5 text-sm font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
          >
            {checking ? "体检中…" : "开始体检"}
          </button>

          {batchProgress && (
            <div className="mt-4">
              <div className="flex justify-between text-xs text-muted">
                <span className="truncate">
                  正在生成：《{batchProgress.label}》
                </span>
                <span>
                  {batchProgress.current}/{batchProgress.total}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-black/8">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{
                    width: `${
                      batchProgress.total === 0
                        ? 100
                        : (batchProgress.current / batchProgress.total) * 100
                    }%`,
                  }}
                />
              </div>
            </div>
          )}

          {error && (
            <p className="mt-3 rounded-xl bg-pred px-3 py-2 text-xs text-pred-t">
              {error}
            </p>
          )}
        </div>

        {/* 历史报告 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {reports.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted">还没有体检报告</p>
          ) : (
            reports.map((r) => (
              <button
                key={r.id}
                onClick={() => void viewReport(r.id)}
                className={`block w-full rounded-[10px] px-2.5 py-2 text-left transition-colors ${
                  r.id === viewingId
                    ? "bg-surface shadow-card"
                    : "hover:bg-hover"
                }`}
              >
                <div className="text-[11px] text-faint">
                  {new Date(r.created_at * 1000).toLocaleString("zh-CN")}
                </div>
                <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-body">
                  {r.preview}…
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* 右：报告 */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-8 py-6">
          {note && (
            <div className="mb-4 rounded-xl bg-white/60 px-3.5 py-2.5 text-[11px] leading-5 text-muted shadow-card">
              {note}
            </div>
          )}
          {reportText ? (
            <div className="rounded-2xl bg-surface p-6 shadow-card">
              <pre className="font-sans text-sm leading-7 whitespace-pre-wrap text-body">
                {reportText}
                {checking && <span className="animate-pulse">▍</span>}
              </pre>
            </div>
          ) : (
            <div className="flex h-full min-h-[50vh] items-center justify-center text-sm text-faint">
              {checking ? "体检报告生成中…" : "点击左侧「开始体检」"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
