import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { IMAGE_PRESETS } from "../lib/stylePresets";
import type { Style } from "../types";

interface CoverViewProps {
  projectId: number;
  projectName: string;
}

/**
 * 封面工坊：AI 出底图，程序排版书名/作者。
 * 历史封面存本地磁盘，点击可回看。
 */
export function CoverView({ projectId, projectName }: CoverViewProps) {
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState(projectName);
  const [author, setAuthor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [covers, setCovers] = useState<string[]>([]);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [coverStyle, setCoverStyle] = useState(""); // 画风锚点词（风格库）
  const [myImageStyles, setMyImageStyles] = useState<Style[]>([]);

  const refresh = useCallback(async () => {
    try {
      setCovers(await api.listCovers(projectId));
    } catch (e) {
      console.error(e);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
    void api.getSetting("author_name").then((v) => {
      if (v) setAuthor(v);
    });
    void api
      .listStyles()
      .then((all) => setMyImageStyles(all.filter((s) => s.kind === "image")))
      .catch(() => {});
  }, [projectId, refresh]);

  const pick = (path: string) => {
    setSelectedPath(path);
    setSelectedUrl(api.fileUrl(path)); // asset 协议直读磁盘，不再走 data URL
  };

  const generate = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const autoDescribe = !prompt.trim();
    try {
      await api.setSetting("author_name", author);
      const r = await api.generateCover(projectId, prompt, title, author, coverStyle);
      setSelectedUrl(r.data_url);
      setSelectedPath(r.path);
      // 自动总结的描述回填到输入框，方便微调后重新生成
      if (autoDescribe && r.prompt) setPrompt(r.prompt);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1">
      {/* 左：生成表单 */}
      <div className="w-80 shrink-0 overflow-y-auto bg-card/45 p-5">
        <h2 className="font-display text-lg font-bold tracking-tight text-ink">
          封面工坊
        </h2>
        <p className="mt-1 text-xs leading-5 text-muted">
          3:4 竖版（番茄 / 起点通用），AI 只画背景，书名由程序排版
        </p>

        <label className="mt-5 block">
          <span className="mb-1.5 block text-xs font-medium text-muted">
            画面描述
            <span className="ml-1.5 font-normal text-faint">
              留空则根据小说内容自动总结
            </span>
          </span>
          <textarea
            className="h-32 w-full resize-none rounded-xl bg-card/60 p-2.5 text-sm leading-6 shadow-card outline-none placeholder:text-faint focus:bg-surface"
            placeholder={
              "留空：AI 会读作品简介/设定/正文，自动总结画面描述并回填到这里\n\n手填例：古风玄幻，少年剑客立于山巅，云海翻腾，远处金色雷霆划破夜空，大气磅礴，暗色调，高质量插画"
            }
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>

        <label className="mt-4 block">
          <span className="mb-1.5 block text-xs font-medium text-muted">
            画风
            <span className="ml-1.5 font-normal text-faint">
              风格库预设/自定义，追加在描述后
            </span>
          </span>
          <select
            className="w-full rounded-[10px] bg-card/60 px-2.5 py-2 text-sm shadow-card outline-none focus:bg-surface"
            value={coverStyle}
            onChange={(e) => setCoverStyle(e.target.value)}
          >
            <option value="">不指定</option>
            {[
              ...IMAGE_PRESETS.map((p) => ({ key: `p:${p.name}`, ...p })),
              ...myImageStyles.map((s) => ({
                key: `u:${s.id}`,
                name: s.name,
                guide: s.guide,
              })),
            ].map((o) => (
              <option key={o.key} value={o.guide}>
                {o.name}
              </option>
            ))}
          </select>
        </label>

        <label className="mt-4 block">
          <span className="mb-1.5 block text-xs font-medium text-muted">
            书名
          </span>
          <input
            className="w-full rounded-[10px] bg-card/60 px-2.5 py-2 text-sm shadow-card outline-none focus:bg-surface"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <label className="mt-4 block">
          <span className="mb-1.5 block text-xs font-medium text-muted">
            作者名
          </span>
          <input
            className="w-full rounded-[10px] bg-card/60 px-2.5 py-2 text-sm shadow-card outline-none placeholder:text-faint focus:bg-surface"
            placeholder="会显示为「xxx 著」"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
          />
        </label>

        <button
          disabled={busy}
          onClick={() => void generate()}
          className="mt-5 w-full rounded-full bg-accent py-2 text-sm font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
        >
          {busy
            ? prompt.trim()
              ? "生成中（约 10~20 秒）…"
              : "先总结描述再出图（约 20~30 秒）…"
            : "生成封面"}
        </button>

        {error && (
          <p className="mt-3 rounded-xl bg-pred px-3 py-2 text-xs text-pred-t">
            {error}
          </p>
        )}

        {selectedPath && (
          <p className="mt-3 break-all text-[11px] leading-5 text-faint">
            {selectedPath}
          </p>
        )}
      </div>

      {/* 右：预览 + 历史 */}
      <div className="min-w-0 flex-1 overflow-y-auto p-8">
        {selectedUrl ? (
          <img
            src={selectedUrl}
            alt="封面预览"
            className="w-64 rounded-2xl shadow-lift"
          />
        ) : (
          <div className="flex h-96 w-64 items-center justify-center rounded-2xl border border-dashed border-black/15 bg-card/45 text-sm text-faint">
            封面预览
          </div>
        )}

        {covers.length > 0 && (
          <>
            <h3 className="mt-8 text-xs font-semibold text-muted">
              历史封面（{covers.length}）
            </h3>
            <div className="mt-3 flex flex-wrap gap-3">
              {covers.map((path) => (
                <CoverThumb
                  key={path}
                  path={path}
                  active={path === selectedPath}
                  onPick={pick}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CoverThumb({
  path,
  active,
  onPick,
}: {
  path: string;
  active: boolean;
  onPick: (path: string) => void;
}) {
  // asset 协议直读磁盘，同步出 URL，WebView 缓存管二次加载
  const url = api.fileUrl(path);

  return (
    <button
      onClick={() => onPick(path)}
      className={`overflow-hidden rounded-xl transition-all ${
        active
          ? "shadow-glow ring-2 ring-accent"
          : "shadow-card hover:-translate-y-0.5 hover:shadow-lift"
      }`}
    >
      <img
        src={url}
        alt="历史封面"
        loading="lazy"
        className="h-24 w-[72px] bg-card/60 object-cover"
      />
    </button>
  );
}
