import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { AI_FLAVOR_WORDS } from "../lib/aiWords";
import { ReportMarkdown } from "./Markdown";
import type { CheckFixPlan, CheckReportMeta, DialogueStats, ScanHit } from "../types";

interface CheckViewProps {
  projectId: number;
}

/**
 * 全书评分：真人读者视角的总评——总分/维度分/优缺点/文笔/风格与主题贴合度。
 * 全书正文逐段通读（每批约 7000 字做评注笔记，汇总出报告），不漏掉任何一段；
 * 摘要链是情节评价的增强材料，所以保留"补齐摘要"入口。
 */
/** 从报告 Markdown 提取总分（## 总分 节里的 X.X/10），旧格式体检报告提取不到则不显示 */
function extractScore(text: string): string | null {
  const m = text.match(/##\s*总分[\s\S]{0,120}?(\d+(?:\.\d+)?)\s*\/\s*10/);
  return m ? m[1] : null;
}

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
  const [dlgStats, setDlgStats] = useState<DialogueStats | null>(null);

  // 合规扫描
  const [wordsText, setWordsText] = useState("");
  const [scanning, setScanning] = useState(false);
  const [hits, setHits] = useState<ScanHit[] | null>(null);
  const [totalWords, setTotalWords] = useState(0);
  const [scanMsg, setScanMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStats(await api.summaryStats(projectId));
      setReports(await api.listCheckReports(projectId));
      setDlgStats(await api.dialogueStats(projectId));
    } catch (e) {
      console.error(e);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
    void api.getSetting("banned_words").then((v) => {
      if (v) setWordsText(v);
    });
  }, [refresh, projectId]);

  // ---------- 合规扫描 ----------

  const runScan = async () => {
    const words = wordsText
      .split(/[,，\n]/)
      .map((w) => w.trim())
      .filter(Boolean);
    if (words.length === 0 || scanning) return;
    setScanning(true);
    setError(null);
    setScanMsg(null);
    setHits(null);
    try {
      await api.setSetting("banned_words", wordsText);
      const result = await api.scanBannedWords(projectId, words);
      setHits(result.hits);
      setTotalWords(result.total_words);
      if (result.hits.length === 0) setScanMsg("未发现敏感内容");
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  };

  /** 把命中章节打包成跨章改写任务（AI 味词表命中走去味指令，其余走合规指令） */
  const enqueueFix = async () => {
    if (!hits || hits.length === 0) return;
    const ids = [...new Set(hits.map((h) => h.chapter_id))];
    const words = [...new Set(hits.map((h) => h.word))];
    const aiSet = new Set(AI_FLAVOR_WORDS);
    const isAiScan = words.length > 0 && words.every((w) => aiSet.has(w));
    const instruction = isAiScan
      ? `以下章节AI味偏重（高频命中：${words.join("、")}）。请逐章去AI味改写：\
替换高频词为具体动作或直陈、拆排比与「不是A，而是B」等套路句式、心理描写外化、\
打破均匀节奏、对话去腔调、结尾不总结升华；保持情节、人物关系与前后章连贯不变。`
      : `以下章节含有敏感内容（${words.join("、")}）。\
请把这些描写改写成合规表达：弱化或替换直白表述，保持剧情走向、人物关系和本章节奏不变，\
不与前后章摘要矛盾。`;
    try {
      await api.enqueueRewriteChapters(projectId, ids, instruction);
      setScanMsg(`已入队整改 ${ids.length} 章（任务页看进度，可回滚）`);
      setHits(null);
    } catch (e) {
      setError(String(e));
    }
  };

  /** 高频命中词 Top8（按次数降序），AI 味扫描时看重灾区 */
  const topWords = useMemo(() => {
    if (!hits) return [];
    const m = new Map<string, number>();
    for (const h of hits) m.set(h.word, (m.get(h.word) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [hits]);

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
            label: `正在生成：《${e.label}》`,
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

  // ---------- 压缩远期摘要（分层记忆） ----------

  const runCompressEra = async () => {
    setBatchProgress({ current: 0, total: 0, label: "准备中…" });
    setError(null);
    setScanMsg(null);
    try {
      const msg = await api.compressEraSummaries(projectId, (e) => {
        if (e.type === "progress") {
          setBatchProgress({
            current: e.current,
            total: e.total,
            label: e.label,
          });
        } else if (e.type === "error") {
          setError(e.message);
        }
      });
      setScanMsg(msg);
      void refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBatchProgress(null);
    }
  };

  // ---------- 体检 ----------

  const runCheck = async () => {
    setChecking(true);
    setError(null);
    setNote(null);
    setReportText("");
    setViewingId(null);
    setFixPlan(null);
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
    setFixPlan(null);
    setReportText(await api.getCheckReport(id));
  };

  // ---------- 整改方案（评分 → AI 出方案 → 一键入队跨章改写） ----------

  const [fixPlan, setFixPlan] = useState<CheckFixPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [enqueuing, setEnqueuing] = useState(false);

  const makePlan = async () => {
    if (planning || viewingId == null) return;
    setPlanning(true);
    setError(null);
    setFixPlan(null);
    try {
      setFixPlan(await api.makeCheckFixPlan(projectId, viewingId));
    } catch (e) {
      setError(String(e));
    } finally {
      setPlanning(false);
    }
  };

  const enqueueFixPlan = async () => {
    if (!fixPlan || fixPlan.chapter_ids.length === 0 || enqueuing) return;
    setEnqueuing(true);
    setError(null);
    try {
      await api.enqueueRewriteChapters(projectId, fixPlan.chapter_ids, fixPlan.instruction);
      setScanMsg(
        `整改已入队：${fixPlan.chapter_titles.length} 章（任务页看进度，可整批回滚）`,
      );
      setFixPlan(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setEnqueuing(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1">
      {/* 左：操作 + 历史 */}
      <div className="flex w-72 shrink-0 flex-col bg-card/45">
        <div className="p-5">
          <h2 className="font-display text-lg font-bold tracking-tight text-ink">
            全书评分
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted">
            真人读者视角总评：打分 / 优缺点 / 文笔 / 风格主题贴合
          </p>

          <div className="mt-4 rounded-xl bg-card/60 px-3 py-2.5 text-xs text-body shadow-card">
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
                摘要是情节评价的增强材料，补齐更准
              </span>
            )}
          </div>

          {missing > 0 && (
            <button
              disabled={busy}
              onClick={() => void runBatchSummaries()}
              className="mt-3 w-full rounded-full bg-card/70 px-3 py-1.5 text-sm text-body shadow-card transition-colors hover:bg-surface disabled:opacity-40"
            >
              补齐 {missing} 章摘要
            </button>
          )}
          {withSummary > 30 && (
            <button
              disabled={busy}
              title="更早的章节摘要压成每 50 章一段梗概，写作时与近期摘要一起注入——摘要预算装不下几百章的解药"
              onClick={() => void runCompressEra()}
              className="mt-2 w-full rounded-full bg-card/70 px-3 py-1.5 text-sm text-body shadow-card transition-colors hover:bg-surface disabled:opacity-40"
            >
              压缩远期摘要（{withSummary} 章已可分层）
            </button>
          )}

          <button
            disabled={busy || total === 0}
            onClick={() => void runCheck()}
            className="mt-2 w-full rounded-full bg-accent px-3 py-1.5 text-sm font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
          >
            {checking ? "评分中…" : "开始评分"}
          </button>
          <p className="mt-2 text-[11px] leading-4 text-faint">
            逐段通读全书正文（每段约 7000 字），字数越多耗时越长，中途可切走
          </p>

          {/* 对话节奏（本地统计，AI 味的结构性指标：对话段 AI 值显著低于大段描写） */}
          {dlgStats && dlgStats.chapters.length > 0 && (
            <div className="mt-5 border-t border-line pt-4">
              <p className="text-xs font-semibold text-muted">
                对话占比
                <span className="ml-1.5 font-normal text-faint">
                  全书 {(dlgStats.total_ratio * 100).toFixed(1)}%
                </span>
              </p>
              <p className="mt-1 text-[11px] leading-4 text-faint">
                网文健康区间约 20%~45%；占比过低 = 大段叙述/描写堆砌（AI 检测重灾区），过高 = 剧情稀
              </p>
              {(() => {
                const low = dlgStats.chapters
                  .filter((c) => c.words > 800 && c.dialogue_ratio < 0.15)
                  .sort((a, b) => a.dialogue_ratio - b.dialogue_ratio)
                  .slice(0, 6);
                if (low.length === 0) {
                  return (
                    <p className="mt-2 text-[11px] text-pgreen-t">
                      各章节奏健康，没有低于 15% 的重描写章节
                    </p>
                  );
                }
                return (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {low.map((c) => (
                      <span
                        key={c.chapter_id}
                        title={`${c.words} 字`}
                        className="rounded-full bg-card/60 px-2 py-0.5 text-[10px] text-muted shadow-card"
                      >
                        {c.title} {(c.dialogue_ratio * 100).toFixed(0)}%
                      </span>
                    ))}
                  </div>
                );
              })()}
            </div>
          )}

          {/* 合规扫描（含 AI 味预设词表） */}
          <div className="mt-5 border-t border-line pt-4">
            <div className="flex items-center">
              <p className="text-xs font-semibold text-muted">合规 / AI味扫描</p>
              <button
                disabled={busy || scanning}
                onClick={() => setWordsText(AI_FLAVOR_WORDS.join("\n"))}
                className="ml-auto rounded-full bg-card/70 px-2.5 py-1 text-[11px] text-body shadow-card transition-colors hover:bg-surface disabled:opacity-40"
              >
                填入AI味词表
              </button>
            </div>
            <textarea
              className="mt-2 h-16 w-full resize-none rounded-[10px] bg-card/60 px-3 py-2 text-xs leading-5 shadow-card outline-none placeholder:text-faint focus:bg-surface"
              placeholder="敏感词或AI味词，逗号或换行分隔，如：赌博, 黑帮"
              value={wordsText}
              onChange={(e) => setWordsText(e.target.value)}
            />
            <button
              disabled={busy || scanning || !wordsText.trim()}
              onClick={() => void runScan()}
              className="mt-2 w-full rounded-full bg-card/70 px-3 py-1.5 text-sm text-body shadow-card transition-colors hover:bg-surface disabled:opacity-40"
            >
              {scanning ? "扫描中…" : "扫描内容"}
            </button>
            {scanMsg && (
              <p className="mt-2 text-xs leading-5 text-pgreen-t">{scanMsg}</p>
            )}
            {hits && hits.length > 0 && (
              <div className="mt-2">
                <p className="text-[11px] text-muted">
                  命中 {hits.length}
                  {hits.length >= 200 ? "+" : ""} 处 · 涉及{" "}
                  {new Set(hits.map((h) => h.chapter_id)).size} 章
                  {totalWords > 0 &&
                    ` · 密度 ${((hits.length / totalWords) * 10000).toFixed(1)} 处/万字`}
                </p>
                {topWords.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {topWords.map(([w, n]) => (
                      <span
                        key={w}
                        className="rounded-full bg-card/60 px-2 py-0.5 text-[10px] text-muted shadow-card"
                      >
                        {w} ×{n}
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-1.5 max-h-44 overflow-y-auto">
                  {hits.map((h, i) => (
                    <div key={i} className="rounded-lg bg-card/60 px-2.5 py-1.5 text-[11px] leading-4 text-muted shadow-card">
                      <span className="font-medium text-body">{h.title}</span>
                      <span className="mx-1 rounded bg-pred px-1 py-px text-[10px] text-pred-t">
                        {h.word}
                      </span>
                      <span className="text-faint">{h.context}</span>
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => void enqueueFix()}
                  className="mt-2 w-full rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h"
                >
                  入队整改这些章节（可回滚）
                </button>
              </div>
            )}
          </div>

          {batchProgress && (
            <div className="mt-4">
              <div className="flex justify-between text-xs text-muted">
                <span className="truncate">{batchProgress.label}</span>
                <span>
                  {batchProgress.current}/{batchProgress.total}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-track">
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
            <p className="px-1 py-2 text-xs text-muted">还没有评分报告</p>
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
            <div className="mb-4 rounded-xl bg-card/60 px-3.5 py-2.5 text-[11px] leading-5 text-muted shadow-card">
              {note}
            </div>
          )}
          {reportText ? (
            <div className="rounded-2xl bg-surface p-6 shadow-card">
              {(() => {
                const score = extractScore(reportText);
                return score != null && !checking ? (
                  <div className="mb-4 flex items-end gap-2 border-b border-line pb-4">
                    <span className="font-display text-4xl font-bold text-accent">
                      {score}
                    </span>
                    <span className="pb-1 text-sm text-muted">
                      / 10 · 真人读者总评
                    </span>
                  </div>
                ) : null;
              })()}
              <div className="text-body">
                <ReportMarkdown text={reportText} />
                {checking && <span className="animate-pulse">▍</span>}
              </div>

              {/* 整改方案：AI 按报告定位章节出方案 → 一键入队跨章改写（快照可回滚） */}
              {!checking && viewingId != null && !fixPlan && (
                <button
                  disabled={planning}
                  onClick={() => void makePlan()}
                  className="mt-4 rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
                >
                  {planning ? "方案生成中…" : "AI 出整改方案"}
                </button>
              )}
              {fixPlan && (
                <div className="mt-4 rounded-2xl bg-canvas p-4 shadow-card">
                  <div className="flex items-center gap-2">
                    <p className="text-[13px] font-bold text-ink">整改方案</p>
                    <span className="text-[11px] text-muted">
                      涉及 {fixPlan.chapter_titles.length} 章
                    </span>
                    <button
                      className="ml-auto text-[11px] text-faint hover:text-body"
                      onClick={() => setFixPlan(null)}
                    >
                      收起
                    </button>
                  </div>
                  <div className="mt-2">
                    <ReportMarkdown text={fixPlan.plan} />
                  </div>
                  {fixPlan.chapter_titles.length > 0 ? (
                    <>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {fixPlan.chapter_titles.map((t) => (
                          <span
                            key={t}
                            className="rounded-full bg-card/70 px-2 py-0.5 text-[11px] text-muted shadow-card"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                      <div className="mt-3 flex items-center gap-2.5">
                        <button
                          disabled={enqueuing}
                          onClick={() => void enqueueFixPlan()}
                          className="rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
                        >
                          {enqueuing ? "入队中…" : "一键整改这些章节（可回滚）"}
                        </button>
                        <span className="text-[11px] text-faint">
                          走跨章改写队列，每章先快照，任务页可整批回滚
                        </span>
                      </div>
                    </>
                  ) : (
                    <p className="mt-2 text-[12px] text-faint">
                      方案认为没有需要动章节的实质问题
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-full min-h-[50vh] items-center justify-center text-sm text-faint">
              {checking ? "评分报告生成中…" : "点击左侧「开始评分」"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
