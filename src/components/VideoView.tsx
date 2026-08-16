import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { IMAGE_PRESETS, VIDEO_PRESETS } from "../lib/stylePresets";
import type { ChapterMeta, Style, Video, VideoDetail, VideoShot } from "../types";

interface VideoViewProps {
  projectId: number;
  chapters: ChapterMeta[];
}

interface Progress {
  current: number;
  total: number;
  label: string;
}

/**
 * 视频工坊：口播稿 → 分镜 → 逐镜生图 → 配音 → 合成。
 * 每步产物落库，可单步重跑（一镜画崩只重画该镜）。
 */
export function VideoView({ projectId, chapters }: VideoViewProps) {
  const [videos, setVideos] = useState<Video[]>([]);
  const [detail, setDetail] = useState<VideoDetail | null>(null);

  // 新建
  const [creating, setCreating] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<"image" | "video">("image"); // 静图运镜 / 图生视频
  const [createStyle, setCreateStyle] = useState(""); // 创建时选的画风锚点词
  const [createMotion, setCreateMotion] = useState(""); // 创建时选的运镜锚点词

  // 口播稿
  const [narration, setNarration] = useState("");
  const [narrationBusy, setNarrationBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const narrationTimer = useRef<number | null>(null);

  // 全片统一画风（生成期注入每个镜头，防跨镜风格漂移）+ 运镜风格
  const [style, setStyle] = useState("");
  const [motion, setMotion] = useState("");
  const [styleOptions, setStyleOptions] = useState<Style[]>([]);

  useEffect(() => {
    void api
      .listStyles()
      .then(setStyleOptions)
      .catch(() => {});
  }, []);

  // 分镜 / 流水线
  const [storyboardBusy, setStoryboardBusy] = useState(false);
  const [progress, setProgress] = useState<(Progress & { stage: string }) | null>(
    null
  );
  const [shotBusy, setShotBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 预览
  const [selectedShot, setSelectedShot] = useState<number | null>(null);
  const [thumbUrls, setThumbUrls] = useState<Record<number, string>>({});

  const refreshVideos = useCallback(async () => {
    try {
      setVideos(await api.listVideos(projectId));
    } catch (e) {
      console.error(e);
    }
  }, [projectId]);

  useEffect(() => {
    void refreshVideos();
    setDetail(null);
    setCreating(false);
  }, [refreshVideos]);

  const loadDetail = useCallback(async (videoId: number) => {
    const d = await api.getVideoDetail(videoId);
    setDetail(d);
    setNarration(d.video.narration);
    setStyle(d.video.style);
    setMotion(d.video.motion_style);
    setSelectedShot(null);
  }, []);

  /** 保存统一画风/运镜风格（失焦即存） */
  const saveStyle = async (styleValue: string, motionValue: string) => {
    if (!detail) return;
    if (
      styleValue === detail.video.style &&
      motionValue === detail.video.motion_style
    )
      return;
    await api.setVideoStyle(detail.video.id, styleValue, motionValue);
    setDetail((d) =>
      d
        ? {
            ...d,
            video: { ...d.video, style: styleValue, motion_style: motionValue },
          }
        : d,
    );
  };

  // 镜头缩略图：有图的镜头转成 data URL
  useEffect(() => {
    if (!detail) return;
    let cancelled = false;
    void (async () => {
      const next: Record<number, string> = {};
      for (const s of detail.shots) {
        // asset 协议直读磁盘（镜头图路径带时间戳，重绘即新路径）
        if (s.image_path && !thumbUrls[s.id]) {
          next[s.id] = api.fileUrl(s.image_path);
        }
      }
      if (!cancelled && Object.keys(next).length > 0) {
        setThumbUrls((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);

  // ---------- 新建 ----------

  const create = async () => {
    if (picked.size === 0) return;
    const title = `推文 ${new Date().toLocaleDateString("zh-CN")}`;
    const v = await api.createVideo(
      projectId,
      title,
      [...picked].sort((a, b) => a - b),
      mode,
      createStyle,
      mode === "video" ? createMotion : ""
    );
    setCreating(false);
    setPicked(new Set());
    await refreshVideos();
    await loadDetail(v.id);
  };

  /** 画风/运镜的可选项 = 内置预设 + 我的风格卡 */
  const imageOptions = [
    ...IMAGE_PRESETS.map((p) => ({ key: `p:${p.name}`, name: p.name, guide: p.guide })),
    ...styleOptions
      .filter((s) => s.kind === "image")
      .map((s) => ({ key: `u:${s.id}`, name: s.name, guide: s.guide })),
  ];
  const videoOptions = [
    ...VIDEO_PRESETS.map((p) => ({ key: `p:${p.name}`, name: p.name, guide: p.guide })),
    ...styleOptions
      .filter((s) => s.kind === "video")
      .map((s) => ({ key: `u:${s.id}`, name: s.name, guide: s.guide })),
  ];

  /** 镜头视频入队（任务队列执行，进度看任务面板/右下角浮条） */
  const enqueueShotVideos = async () => {
    if (!detail) return;
    setError(null);
    try {
      await api.enqueueVideoShots(detail.video.id);
    } catch (e) {
      setError(String(e));
    }
  };

  // ---------- BGM / 片头片尾 ----------

  /** 保存 extras（BGM/片头/片尾/音量），保存后刷新 detail */
  const saveExtras = async (patch: {
    bgmPath?: string;
    bgmVolume?: number;
    introPath?: string;
    outroPath?: string;
  }) => {
    if (!detail) return;
    const v = detail.video;
    try {
      await api.setVideoExtras(
        v.id,
        patch.bgmPath ?? v.bgm_path,
        patch.bgmVolume ?? v.bgm_volume,
        patch.introPath ?? v.intro_path,
        patch.outroPath ?? v.outro_path
      );
      await loadDetail(v.id);
    } catch (e) {
      setError(String(e));
    }
  };

  const pickExtra = async (
    kind: "bgm" | "intro" | "outro"
  ) => {
    const path = kind === "bgm" ? await api.pickAudio() : await api.pickMedia();
    if (!path) return;
    if (kind === "bgm") await saveExtras({ bgmPath: path });
    else if (kind === "intro") await saveExtras({ introPath: path });
    else await saveExtras({ outroPath: path });
  };

  /** 单镜重跑视频 */
  const rerunShotVideo = async (shot: VideoShot) => {
    if (shotBusy != null) return;
    setShotBusy(shot.id);
    setError(null);
    try {
      await api.generateShotVideo(shot.id);
      if (detail) await loadDetail(detail.video.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setShotBusy(null);
    }
  };

  // ---------- 口播稿 ----------

  const scheduleNarrationSave = (text: string) => {
    if (narrationTimer.current != null) window.clearTimeout(narrationTimer.current);
    narrationTimer.current = window.setTimeout(() => {
      if (detail) void api.saveNarration(detail.video.id, text);
    }, 800);
  };

  const runNarration = async () => {
    if (!detail || narrationBusy) return;
    setNarrationBusy(true);
    setError(null);
    setNote(null);
    let acc = "";
    setNarration("");
    try {
      await api.generateNarration(detail.video.id, (e) => {
        if (e.type === "meta") setNote(e.note);
        else if (e.type === "delta") {
          acc += e.text;
          setNarration(acc);
        } else if (e.type === "error") setError(e.message);
      });
      if (acc.trim()) await api.saveNarration(detail.video.id, acc);
    } catch (e) {
      setError(String(e));
    } finally {
      setNarrationBusy(false);
    }
  };

  // ---------- 分镜 ----------

  const runStoryboard = async () => {
    if (!detail || storyboardBusy) return;
    setStoryboardBusy(true);
    setError(null);
    try {
      await api.saveNarration(detail.video.id, narration);
      const d = await api.generateStoryboard(detail.video.id);
      setDetail(d);
      setThumbUrls({});
    } catch (e) {
      setError(String(e));
    } finally {
      setStoryboardBusy(false);
    }
  };

  // ---------- 流水线 ----------

  const runStage = (stage: "image" | "voice" | "compose") => {
    if (!detail || progress) return;
    setError(null);
    const vid = detail.video.id;
    const labelOf = { image: "配图", voice: "配音", compose: "合成" }[stage];
    const invoke =
      stage === "image"
        ? api.generateMissingImages
        : stage === "voice"
          ? api.synthesizeVoices
          : api.composeVideo;
    setProgress({ current: 0, total: 0, label: "准备中…", stage: labelOf });
    void invoke(vid, (e) => {
      if (e.type === "progress") {
        setProgress({
          current: e.current,
          total: e.total,
          label: e.label,
          stage: labelOf,
        });
      } else if (e.type === "error") {
        setError(e.message);
        setProgress(null);
      } else if (e.type === "done") {
        setProgress(null);
        void loadDetail(vid);
      }
    }).catch((e) => {
      setError(String(e));
      setProgress(null);
    });
  };

  const redrawShot = async (shot: VideoShot) => {
    if (shotBusy != null) return;
    setShotBusy(shot.id);
    setError(null);
    try {
      const path = await api.generateShotImage(shot.id);
      setThumbUrls((prev) => ({ ...prev, [shot.id]: api.fileUrl(path) }));
      if (detail) await loadDetail(detail.video.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setShotBusy(null);
    }
  };

  const busy = narrationBusy || storyboardBusy || progress != null;

  return (
    <div className="flex min-h-0 flex-1">
      {/* 左：流水线 */}
      <div className="flex w-[340px] shrink-0 flex-col overflow-y-auto bg-card/45 p-5">
        <h2 className="font-display text-lg font-bold tracking-tight text-ink">
          视频工坊
        </h2>
        <p className="mt-1 text-xs leading-5 text-muted">
          口播稿 → 分镜 → 配图 → 配音 → 合成，竖屏 1080×1920
        </p>

        {/* 视频列表 */}
        <div className="mt-4 flex items-center justify-between">
          <span className="text-xs font-semibold text-muted">视频</span>
          <button
            className="rounded-lg px-2 py-1 text-xs text-body transition-colors hover:bg-hover"
            onClick={() => setCreating((v) => !v)}
          >
            ＋ 新建
          </button>
        </div>

        {creating && (
          <div className="mt-2 rounded-2xl bg-surface p-3.5 shadow-card">
            <p className="mb-2 text-xs text-muted">选择取材章节（可多选）</p>
            <div className="max-h-36 overflow-y-auto">
              {chapters.map((c) => (
                <label
                  key={c.id}
                  className="flex cursor-pointer items-center gap-2 py-1 text-[13px] text-body"
                >
                  <input
                    type="checkbox"
                    className="accent-[#007AFF]"
                    checked={picked.has(c.id)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(c.id);
                      else next.delete(c.id);
                      setPicked(next);
                    }}
                  />
                  <span className="truncate">{c.title}</span>
                </label>
              ))}
            </div>
            <div className="mt-2.5 flex gap-1 rounded-full bg-canvas p-1">
              {(
                [
                  ["image", "静图运镜（免费）"],
                  ["video", "图生视频（Seedance 计费）"],
                ] as ["image" | "video", string][]
              ).map(([m, label]) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`flex-1 rounded-full px-2 py-1 text-[11px] transition-colors ${
                    mode === m
                      ? "bg-surface font-semibold text-ink shadow-card"
                      : "text-muted hover:text-body"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <select
              className="mt-2 w-full rounded-[10px] bg-canvas px-3 py-2 text-[12px] text-body outline-none focus:bg-surface2"
              value={createStyle}
              onChange={(e) => setCreateStyle(e.target.value)}
            >
              <option value="">画风：默认（精美动漫插画）</option>
              {imageOptions.map((o) => (
                <option key={o.key} value={o.guide}>
                  画风：{o.name}
                </option>
              ))}
            </select>
            {mode === "video" && (
              <select
                className="mt-2 w-full rounded-[10px] bg-canvas px-3 py-2 text-[12px] text-body outline-none focus:bg-surface2"
                value={createMotion}
                onChange={(e) => setCreateMotion(e.target.value)}
              >
                <option value="">运镜：默认（镜头缓慢轻微）</option>
                {videoOptions.map((o) => (
                  <option key={o.key} value={o.guide}>
                    运镜：{o.name}
                  </option>
                ))}
              </select>
            )}
            <button
              disabled={picked.size === 0}
              className="mt-2.5 w-full rounded-full bg-accent py-1.5 text-xs font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
              onClick={() => void create()}
            >
              创建视频任务
            </button>
          </div>
        )}

        <div className="mt-2">
          {videos.length === 0 && !creating && (
            <p className="py-2 text-xs text-muted">还没有视频任务</p>
          )}
          {videos.map((v) => (
            <button
              key={v.id}
              onClick={() => void loadDetail(v.id)}
              className={`block w-full rounded-[10px] px-2.5 py-2 text-left transition-colors ${
                detail?.video.id === v.id
                  ? "bg-surface shadow-card"
                  : "hover:bg-hover"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="truncate text-[13px] font-medium text-ink">
                  {v.title}
                </span>
                <StatusTag status={v.status} />
              </div>
              <div className="mt-0.5 text-[11px] text-faint">
                {new Date(v.created_at * 1000).toLocaleString("zh-CN")}
              </div>
            </button>
          ))}
        </div>

        {detail && (
          <>
            {/* 全片统一画风 + 运镜风格：生成期注入每个镜头的生图/运动 prompt */}
            <div className="mb-3 rounded-2xl bg-surface p-3.5 shadow-card">
              <span className="mb-1.5 block text-xs font-medium text-muted">
                统一画风（防跨镜风格漂移，留空用默认「精美动漫插画」）
              </span>
              <input
                className="w-full rounded-[10px] bg-canvas px-3 py-2 text-[13px] outline-none placeholder:text-faint focus:bg-surface2"
                placeholder="如：古风玄幻插画 / 日系赛璐璐 / 韩系厚涂，失焦自动保存"
                value={style}
                onChange={(e) => setStyle(e.target.value)}
                onBlur={() => void saveStyle(style, motion)}
              />
              <select
                className="mt-1.5 w-full rounded-[10px] bg-canvas px-3 py-1.5 text-[12px] text-muted outline-none focus:bg-surface2"
                value=""
                onChange={(e) => {
                  const o = imageOptions.find((x) => x.guide === e.target.value);
                  if (!o) return;
                  setStyle(o.guide);
                  void saveStyle(o.guide, motion);
                }}
              >
                <option value="">从风格库选画风（内置 + 我的）…</option>
                {imageOptions.map((o) => (
                  <option key={o.key} value={o.guide}>
                    {o.name}
                  </option>
                ))}
              </select>
              {detail.video.mode === "video" && (
                <>
                  <span className="mt-3 mb-1.5 block text-xs font-medium text-muted">
                    运镜风格（注入图生视频运动提示词，留空用默认收敛词）
                  </span>
                  <select
                    className="w-full rounded-[10px] bg-canvas px-3 py-2 text-[13px] outline-none focus:bg-surface2"
                    value={motion}
                    onChange={(e) => {
                      setMotion(e.target.value);
                      void saveStyle(style, e.target.value);
                    }}
                  >
                    <option value="">默认（镜头缓慢轻微）</option>
                    {videoOptions.map((o) => (
                      <option key={o.key} value={o.guide}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>

            {/* 第一步：口播稿 */}
            <Section title="① 口播稿" action={
              <button
                disabled={busy}
                onClick={() => void runNarration()}
                className="rounded-full bg-accent px-3 py-1 text-[11px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
              >
                {narrationBusy ? "生成中…" : narration ? "重新生成" : "AI 生成"}
              </button>
            }>
              {note && (
                <p className="mb-1.5 text-[11px] text-faint">{note}</p>
              )}
              <textarea
                className="h-36 w-full resize-none rounded-xl bg-card/70 p-3 text-[13px] leading-6 text-body shadow-card outline-none placeholder:text-faint focus:bg-surface"
                placeholder="口播稿（可手写），250~350 字对应 60~90 秒"
                value={narration}
                onChange={(e) => {
                  setNarration(e.target.value);
                  scheduleNarrationSave(e.target.value);
                }}
              />
              <p className="mt-1 text-[11px] text-faint">
                {narration.replace(/\s/g, "").length} 字 · 修改自动保存
              </p>
            </Section>

            {/* 第二步：分镜 */}
            <Section title={`② 分镜${detail.shots.length > 0 ? `（${detail.shots.length} 镜）` : ""}`} action={
              <button
                disabled={busy || narration.trim().length === 0}
                onClick={() => void runStoryboard()}
                className="rounded-full bg-accent px-3 py-1 text-[11px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
              >
                {storyboardBusy ? "生成中…" : detail.shots.length > 0 ? "重新分镜" : "生成分镜"}
              </button>
            }>
              <div className="flex flex-col gap-2.5">
                {detail.shots.map((s) => (
                  <ShotCard
                    key={s.id}
                    shot={s}
                    thumb={thumbUrls[s.id]}
                    busy={shotBusy === s.id}
                    selected={selectedShot === s.id}
                    videoMode={detail.video.mode === "video"}
                    onSelect={() => setSelectedShot(s.id)}
                    onRedraw={() => void redrawShot(s)}
                    onRerunVideo={() => void rerunShotVideo(s)}
                    onSavePrompt={(p) => void api.updateShotPrompt(s.id, p)}
                  />
                ))}
              </div>
            </Section>

            {/* 第三步：执行 */}
            <Section title="③ 执行">
              {/* BGM / 片头片尾 */}
              <div className="mb-2.5 flex flex-col gap-1.5 rounded-xl bg-canvas p-3">
                <ExtrasRow
                  label="BGM"
                  path={detail.video.bgm_path}
                  onPick={() => void pickExtra("bgm")}
                  onClear={() => void saveExtras({ bgmPath: "" })}
                />
                {detail.video.bgm_path && (
                  <div className="flex items-center gap-2 pl-1">
                    <span className="text-[10px] text-faint">音量</span>
                    <input
                      type="range"
                      min={5}
                      max={50}
                      value={detail.video.bgm_volume}
                      onChange={(e) =>
                        void saveExtras({ bgmVolume: parseInt(e.target.value, 10) })
                      }
                      className="h-1 w-28 accent-[#007AFF]"
                    />
                    <span className="text-[10px] text-faint">
                      {detail.video.bgm_volume}%
                    </span>
                  </div>
                )}
                <ExtrasRow
                  label="片头"
                  path={detail.video.intro_path}
                  onPick={() => void pickExtra("intro")}
                  onClear={() => void saveExtras({ introPath: "" })}
                />
                <ExtrasRow
                  label="片尾"
                  path={detail.video.outro_path}
                  onPick={() => void pickExtra("outro")}
                  onClear={() => void saveExtras({ outroPath: "" })}
                />
              </div>

              <div className="flex flex-col gap-2">
                <StageButton
                  label="补齐配图"
                  hint={`${detail.shots.filter((s) => s.image_path).length}/${detail.shots.length} 已有图`}
                  disabled={busy || detail.shots.length === 0}
                  onClick={() => runStage("image")}
                />
                {detail.video.mode === "video" && (
                  <StageButton
                    label="镜头视频（入队）"
                    hint={`${detail.shots.filter((s) => s.video_path).length}/${detail.shots.length} 已有视频 · 进度看任务页`}
                    disabled={busy || detail.shots.length === 0}
                    onClick={() => void enqueueShotVideos()}
                  />
                )}
                <StageButton
                  label="生成配音"
                  hint={`${detail.shots.filter((s) => s.audio_path).length}/${detail.shots.length} 已配音`}
                  disabled={busy || detail.shots.length === 0}
                  onClick={() => runStage("voice")}
                />
                <StageButton
                  label="合成视频"
                  hint={
                    detail.video.status === "done"
                      ? "已完成，可再次合成"
                      : detail.video.mode === "video"
                        ? "镜头视频 + 字幕"
                        : "静图 + 运镜 + 字幕"
                  }
                  disabled={busy || detail.shots.length === 0}
                  primary
                  onClick={() => runStage("compose")}
                />
              </div>
              {progress && (
                <div className="mt-3">
                  <div className="flex justify-between text-[11px] text-muted">
                    <span className="truncate">
                      {progress.stage}：{progress.label}
                    </span>
                    <span>
                      {progress.current}/{progress.total}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-track">
                    <div
                      className="h-full rounded-full bg-accent transition-all"
                      style={{
                        width: `${
                          progress.total === 0
                            ? 10
                            : (progress.current / progress.total) * 100
                        }%`,
                      }}
                    />
                  </div>
                </div>
              )}
            </Section>
          </>
        )}

        {error && (
          <p className="mt-3 rounded-xl bg-pred px-3.5 py-2.5 text-xs leading-5 text-pred-t">
            {error}
          </p>
        )}
      </div>

      {/* 右：预览 */}
      <Preview
        detail={detail}
        selectedShot={selectedShot}
        thumbUrls={thumbUrls}
      />
    </div>
  );
}

function ExtrasRow({
  label,
  path,
  onPick,
  onClear,
}: {
  label: string;
  path: string;
  onPick: () => void;
  onClear: () => void;
}) {
  const fileName = path ? (path.split(/[\\/]/).pop() ?? path) : "";
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 text-[11px] text-muted">{label}</span>
      <button
        onClick={onPick}
        className="rounded-full bg-card/80 px-2.5 py-0.5 text-[11px] text-body shadow-card transition-colors hover:bg-surface"
      >
        {path ? "更换" : "选择"}
      </button>
      {path && (
        <>
          <span className="min-w-0 flex-1 truncate text-[10px] text-faint">
            {fileName}
          </span>
          <button
            title="清除"
            onClick={onClear}
            className="text-faint hover:text-pred-t"
          >
            ×
          </button>
        </>
      )}
      {!path && <span className="text-[10px] text-faint">未设置</span>}
    </div>
  );
}

function StatusTag({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    done: ["已完成", "bg-pgreen text-pgreen-t"],
    error: ["出错", "bg-pred text-pred-t"],
    draft: ["草稿", "bg-track text-muted"],
  };
  const [label, cls] = map[status] ?? ["进行中", "bg-pyellow text-pyellow-t"];
  return (
    <span
      className={`ml-auto shrink-0 rounded-full px-2 py-px text-[10px] font-medium ${cls}`}
    >
      {label}
    </span>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-muted">{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

function StageButton({
  label,
  hint,
  disabled,
  primary,
  onClick,
}: {
  label: string;
  hint: string;
  disabled?: boolean;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`flex items-center justify-between rounded-full px-4 py-2 text-[13px] transition-colors disabled:opacity-40 ${
        primary
          ? "bg-accent font-semibold text-surface shadow-glow hover:bg-accent-h"
          : "bg-card/70 text-body shadow-card hover:bg-surface"
      }`}
    >
      {label}
      <span className={`text-[11px] ${primary ? "text-white/75" : "text-faint"}`}>
        {hint}
      </span>
    </button>
  );
}

function ShotCard({
  shot,
  thumb,
  busy,
  selected,
  videoMode,
  onSelect,
  onRedraw,
  onRerunVideo,
  onSavePrompt,
}: {
  shot: VideoShot;
  thumb?: string;
  busy: boolean;
  selected: boolean;
  /** 图生视频模式：显示视频状态和单镜重跑 */
  videoMode: boolean;
  onSelect: () => void;
  onRedraw: () => void;
  onRerunVideo: () => void;
  onSavePrompt: (prompt: string) => void;
}) {
  const [prompt, setPrompt] = useState(shot.prompt);
  useEffect(() => setPrompt(shot.prompt), [shot.prompt]);

  return (
    <div
      className={`rounded-2xl bg-surface p-3 transition-shadow ${
        selected ? "shadow-glow ring-1 ring-accent" : "shadow-card"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold text-muted">
          镜头 {shot.idx}
        </span>
        {shot.duration_ms > 0 && (
          <span className="text-[10px] text-faint">
            {(shot.duration_ms / 1000).toFixed(1)}s
          </span>
        )}
        {videoMode && shot.video_path && (
          <span className="rounded-full bg-pgreen px-1.5 py-px text-[10px] text-pgreen-t">
            已出视频
          </span>
        )}
        {videoMode && (
          <button
            disabled={busy || !shot.image_path}
            title={shot.image_path ? "用镜头图生成/重跑视频（约 1~2 分钟）" : "先生成镜头图"}
            onClick={onRerunVideo}
            className="ml-auto rounded-full bg-card/70 px-2.5 py-0.5 text-[11px] text-body shadow-card transition-colors hover:bg-hover disabled:opacity-40"
          >
            {busy ? "处理中…" : shot.video_path ? "重跑视频" : "出视频"}
          </button>
        )}
        <button
          disabled={busy}
          onClick={onRedraw}
          className={`${videoMode ? "" : "ml-auto "}rounded-full bg-card/70 px-2.5 py-0.5 text-[11px] text-body shadow-card transition-colors hover:bg-hover disabled:opacity-40`}
        >
          {busy ? "绘图中…" : shot.image_path ? "重绘" : "生图"}
        </button>
      </div>
      <p className="mt-1.5 text-xs leading-5 text-body">{shot.text}</p>
      <textarea
        className="mt-2 h-16 w-full resize-none rounded-lg bg-canvas p-2 text-[11px] leading-4 text-muted outline-none focus:bg-surface2 focus:text-body"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onBlur={() => prompt !== shot.prompt && onSavePrompt(prompt)}
      />
      <button
        className="mt-2 block w-full overflow-hidden rounded-xl"
        onClick={onSelect}
        title="点击在右侧预览"
      >
        {thumb ? (
          <img src={thumb} alt={`镜头 ${shot.idx}`} className="h-24 w-full object-cover" />
        ) : (
          <div className="flex h-24 w-full items-center justify-center bg-canvas text-[11px] text-faint">
            尚未配图
          </div>
        )}
      </button>
    </div>
  );
}

function Preview({
  detail,
  selectedShot,
  thumbUrls,
}: {
  detail: VideoDetail | null;
  selectedShot: number | null;
  thumbUrls: Record<number, string>;
}) {
  const shot = detail?.shots.find((s) => s.id === selectedShot);
  const done = detail?.video.status === "done" && detail.video.output_path;

  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center p-8">
      {done && !shot ? (
        <div className="flex flex-col items-center">
          <video
            controls
            className="max-h-[62vh] rounded-2xl shadow-lift"
            src={api.fileUrl(detail!.video.output_path)}
          />
          <div className="mt-4 flex items-center gap-3">
            <button
              className="rounded-full bg-card/70 px-4 py-1.5 text-xs text-body shadow-card transition-colors hover:bg-surface"
              onClick={() => void api.openVideoFolder(detail!.video.id)}
            >
              打开所在文件夹
            </button>
            <span className="max-w-md truncate text-[11px] text-faint">
              {detail!.video.output_path}
            </span>
          </div>
        </div>
      ) : shot ? (
        <div className="flex flex-col items-center">
          {thumbUrls[shot.id] ? (
            <img
              src={thumbUrls[shot.id]}
              alt={`镜头 ${shot.idx}`}
              className="max-h-[62vh] rounded-2xl shadow-lift"
            />
          ) : (
            <div className="flex h-96 w-56 items-center justify-center rounded-2xl bg-card/45 text-sm text-faint">
              镜头 {shot.idx} 尚未配图
            </div>
          )}
          <p className="mt-4 max-w-md text-center text-xs leading-5 text-muted">
            {shot.text}
          </p>
        </div>
      ) : (
        <div className="text-center text-sm text-faint">
          {detail
            ? "点击左侧镜头预览配图，合成后在此播放成片"
            : "新建一个视频任务开始"}
        </div>
      )}
    </div>
  );
}
