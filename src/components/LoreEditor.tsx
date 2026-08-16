import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { IMAGE_PRESETS } from "../lib/stylePresets";
import { LORE_CATEGORIES, type LoreEntry, type Style } from "../types";
interface LoreEditorProps {
  entry: LoreEntry;
  onSaved: () => void;
}

/**
 * 设定词条编辑器：全部字段防抖自动保存。
 * 注入规则：always_include 常驻注入；否则关键词命中前文时注入。
 */
export function LoreEditor({ entry, onSaved }: LoreEditorProps) {
  const [draft, setDraft] = useState<LoreEntry>(entry);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dirtyRef = useRef(false);
  const saveTimer = useRef<number | null>(null);

  // 视觉参考图（人物卡 → 分镜生图一致性）
  const [refThumb, setRefThumb] = useState<string | null>(null);
  const [refBusy, setRefBusy] = useState(false);
  const [imgStyle, setImgStyle] = useState(""); // 设定图画风锚点词
  const [myImageStyles, setMyImageStyles] = useState<Style[]>([]);

  useEffect(() => {
    void api
      .listStyles()
      .then((all) => setMyImageStyles(all.filter((x) => x.kind === "image")))
      .catch(() => {});
  }, []);

  useEffect(() => {
    // asset 协议直读磁盘，无需异步取 data URL
    setRefThumb(entry.ref_image ? api.fileUrl(entry.ref_image) : null);
  }, [entry.id, entry.ref_image]);

  const uploadRefImage = async () => {
    if (refBusy) return;
    const picked = await api.pickImage();
    if (!picked || typeof picked !== "string") return;
    setRefBusy(true);
    try {
      const stored = await api.setLoreRefImage(entry.id, picked);
      setRefThumb(api.fileUrl(stored));
      setDraft((d) => ({ ...d, ref_image: stored }));
      onSaved();
    } catch (e) {
      console.error(e);
    } finally {
      setRefBusy(false);
    }
  };

  const removeRefImage = async () => {
    await api.removeLoreRefImage(entry.id);
    setRefThumb(null);
    setDraft((d) => ({ ...d, ref_image: "" }));
    onSaved();
  };

  /** AI 生成三视图设定图（正/侧/背人设图，比单图参考跨镜一致性更稳） */
  const genTripleView = async () => {
    if (refBusy) return;
    if (!draftRef.current.content.trim()) {
      window.alert("先写点外貌/形象描述，AI 才好画");
      return;
    }
    // 三视图按词条当前内容出图，先把未保存的改动落库
    await flushSave();
    setRefBusy(true);
    try {
      const stored = await api.generateLoreRefImage(entry.id, imgStyle);
      setRefThumb(api.fileUrl(stored));
      setDraft((d) => ({ ...d, ref_image: stored }));
      onSaved();
    } catch (e) {
      window.alert(`生成失败：${e}`);
    } finally {
      setRefBusy(false);
    }
  };

  const flushSave = useCallback(async () => {
    if (saveTimer.current != null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    try {
      await api.updateLoreEntry(draftRef.current);
      onSaved();
    } catch (e) {
      console.error("保存设定失败", e);
    }
  }, [onSaved]);

  const update = (patch: Partial<LoreEntry>) => {
    setDraft((d) => ({ ...d, ...patch }));
    dirtyRef.current = true;
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void flushSave(), 600);
  };

  // 卸载兜底保存
  useEffect(() => {
    return () => {
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      if (dirtyRef.current) void api.updateLoreEntry(draftRef.current);
    };
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-6 pt-2 pb-4">
        <input
          className="w-full bg-transparent font-display text-2xl font-bold tracking-tight text-ink outline-none placeholder:text-faint"
          placeholder="词条名称，如：林夜（主角）"
          value={draft.title}
          onChange={(e) => update({ title: e.target.value })}
        />
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <label className="flex items-center gap-1.5">
            <span className="text-xs text-muted">分类</span>
            <select
              className="rounded-lg bg-card/60 px-2 py-1.5 text-sm shadow-card outline-none"
              value={draft.category}
              onChange={(e) => update({ category: e.target.value })}
            >
              {LORE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              className="accent-[#007AFF]"
              checked={draft.always_include}
              onChange={(e) => update({ always_include: e.target.checked })}
            />
            <span className="text-xs text-body">常驻注入（每次续写都带上）</span>
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              className="accent-[#007AFF]"
              checked={draft.enabled}
              onChange={(e) => update({ enabled: e.target.checked })}
            />
            <span className="text-xs text-body">启用</span>
          </label>
        </div>
        <div className="mt-3">
          <input
            className="w-full rounded-[10px] bg-card/60 px-3 py-2 text-[13px] shadow-card outline-none placeholder:text-faint focus:bg-surface"
            placeholder="触发关键词，逗号分隔。前文出现这些词时自动注入本条（如：林夜,阿夜）"
            value={draft.keywords}
            onChange={(e) => update({ keywords: e.target.value })}
          />
        </div>

        {/* 视觉参考图：分镜生图时命中该角色自动带上 */}
        <div className="mt-3 flex items-center gap-3">
          {refThumb ? (
            <img
              src={refThumb}
              alt="参考图"
              className="h-16 w-16 rounded-xl object-cover shadow-card"
            />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-card/60 text-[10px] text-faint shadow-card">
              无参考图
            </div>
          )}
          <div>
            <div className="flex items-center gap-2">
              <button
                disabled={refBusy}
                className="rounded-full bg-card/70 px-3 py-1 text-xs text-body shadow-card transition-colors hover:bg-surface disabled:opacity-40"
                onClick={() => void uploadRefImage()}
              >
                {refBusy ? "处理中…" : refThumb ? "更换参考图" : "上传参考图"}
              </button>
              <button
                disabled={refBusy}
                className="rounded-full bg-accent/10 px-3 py-1 text-xs text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
                onClick={() => void genTripleView()}
              >
                {refBusy
                  ? "处理中…"
                  : draft.category === "人物"
                    ? "AI 生成三视图"
                    : "AI 生成设定图"}
              </button>
              {refThumb && (
                <button
                  className="rounded-full px-3 py-1 text-xs text-pred-t transition-colors hover:bg-pred"
                  onClick={() => void removeRefImage()}
                >
                  移除
                </button>
              )}
              <select
                className="rounded-full bg-card/70 px-2.5 py-1 text-[11px] text-muted shadow-card outline-none"
                value={imgStyle}
                onChange={(e) => setImgStyle(e.target.value)}
                title="生成设定图时追加的画风"
              >
                <option value="">默认画风</option>
                {[
                  ...IMAGE_PRESETS.map((p) => ({ key: `p:${p.name}`, ...p })),
                  ...myImageStyles.map((x) => ({
                    key: `u:${x.id}`,
                    name: x.name,
                    guide: x.guide,
                  })),
                ].map((o) => (
                  <option key={o.key} value={o.guide}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
            <p className="mt-1.5 text-[11px] leading-4 text-faint">
              视频分镜生图/图生视频时，命中该词条会自动带上参考图（最多 3
              张），保证形象一致；「AI 生成」按词条内容出图——人物是正/侧/背三视图，地点是场景概念图，物品是设定图
            </p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[680px] px-8 py-4">
          <textarea
            className="h-[60vh] w-full resize-none rounded-2xl bg-surface p-4 text-[15px] leading-7 text-body shadow-card outline-none placeholder:text-faint"
            placeholder="设定内容。人物卡示例：&#10;林夜，17岁，没落世家次子。表面玩世不恭，实则心思缜密。&#10;身负封印的上古血脉，情绪激动时右眼泛金。&#10;口头禅：「这笔账，记下了。」"
            value={draft.content}
            onChange={(e) => update({ content: e.target.value })}
          />
          <p className="mt-2 text-xs text-faint">
            写得越具体，AI 续写时人设越稳。修改会自动保存。
          </p>
        </div>
      </div>
    </div>
  );
}
