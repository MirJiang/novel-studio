import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { IMAGE_PRESETS } from "../lib/stylePresets";
import { LORE_CATEGORIES, type LoreEntry, type Project, type Style } from "../types";
import { CoverView } from "./CoverView";
import { OutlineSection, SynopsisSection } from "./OutlineView";

interface BookDetailProps {
  project: Project;
  onClose: () => void;
  /** 进入写作态（恢复阅读位置） */
  onOpenWrite: (id: number) => void;
  /** 简介/标签等作品信息变更后刷新外部作品列表 */
  onProjectChanged: () => void;
}

type Tab = "overview" | "outline" | "lore" | "cover";

/**
 * 书籍详情（书架 ⋯ 菜单进入，整页覆盖层）：
 * 概览（简介 AI 生成/手改）· 大纲（AI 生成分卷 + 节点编辑）· 设定（分类浏览 + 逐条生成设定图）· 封面工坊
 */
export function BookDetailView({ project, onClose, onOpenWrite, onProjectChanged }: BookDetailProps) {
  const [tab, setTab] = useState<Tab>("overview");
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [stats, setStats] = useState<{ chapters: number; words: number } | null>(null);
  const [entries, setEntries] = useState<LoreEntry[]>([]);

  const refreshLore = useCallback(async () => {
    try {
      setEntries(await api.listLoreEntries(project.id));
    } catch (e) {
      console.error(e);
    }
  }, [project.id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const covers = await api.listCovers(project.id);
        if (covers.length > 0 && !cancelled) setCoverUrl(api.fileUrl(covers[0]));
      } catch {
        /* 没生成过封面 */
      }
      try {
        const chapters = await api.listChapters(project.id);
        if (!cancelled) {
          setStats({
            chapters: chapters.length,
            words: chapters.reduce((s, c) => s + c.word_count, 0),
          });
        }
      } catch (e) {
        console.error(e);
      }
    })();
    void refreshLore();
    return () => {
      cancelled = true;
    };
  }, [project.id, refreshLore]);

  return (
    <div className="flex h-full flex-col bg-canvas">
      {/* 头部：封面缩略 + 书名 + 页签 + 操作 */}
      <div className="flex items-center gap-4 px-8 pt-5 pb-4">
        <div className="h-20 w-15 shrink-0 overflow-hidden rounded-lg shadow-card">
          {coverUrl ? (
            <img src={coverUrl} alt={project.name} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-track p-1 text-center font-display text-[11px] font-bold text-muted">
              {project.name.slice(0, 6)}
            </div>
          )}
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold tracking-tight text-ink">
            {project.name}
          </h1>
          <p className="mt-0.5 text-xs text-muted">
            {project.description || "原创小说"}
            {stats &&
              ` · ${stats.chapters} 章 · ${stats.words.toLocaleString()} 字`}
          </p>
        </div>

        <div className="mx-2 flex gap-1 rounded-[10px] bg-track p-[3px]">
          {(
            [
              ["overview", "概览"],
              ["outline", "大纲"],
              ["lore", "设定"],
              ["cover", "封面"],
            ] as [Tab, string][]
          ).map(([t, label]) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-md px-4 py-1 text-xs font-medium transition-colors ${
                tab === t
                  ? "bg-surface text-ink shadow-card"
                  : "text-muted hover:text-body"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            className="rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h"
            onClick={() => onOpenWrite(project.id)}
          >
            进入写作
          </button>
          <button
            className="rounded-full bg-card/70 px-3.5 py-1.5 text-xs text-body shadow-card transition-colors hover:bg-surface"
            onClick={onClose}
          >
            返回书架
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "overview" ? (
          <div className="mx-auto max-w-[720px] px-8 py-4">
            <SynopsisSection project={project} onProjectChanged={onProjectChanged} />
            <p className="mt-5 text-[11px] leading-5 text-faint">
              大纲 / 设定 / 封面在上方页签；正文的写作、修改请点「进入写作」
            </p>
          </div>
        ) : tab === "outline" ? (
          <div className="mx-auto max-w-[720px] px-8 py-4">
            <OutlineSection project={project} />
          </div>
        ) : tab === "lore" ? (
          <LoreTab
            projectId={project.id}
            entries={entries}
            onChanged={() => void refreshLore()}
          />
        ) : (
          <CoverView projectId={project.id} projectName={project.name} />
        )}
      </div>
    </div>
  );
}

/** 设定页签：分类页签 + 搜索 + 小卡片网格，点卡片看详情，逐条生成设定图 */
function LoreTab({
  projectId,
  entries,
  onChanged,
}: {
  projectId: number;
  entries: LoreEntry[];
  onChanged: () => void;
}) {
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LoreEntry | null>(null); // 词条详情弹层
  const [collecting, setCollecting] = useState(false);
  const [collectMsg, setCollectMsg] = useState<string | null>(null);
  const [cat, setCat] = useState("全部");
  const [query, setQuery] = useState("");
  const [imgStyle, setImgStyle] = useState(""); // 设定图画风锚点词
  const [myImageStyles, setMyImageStyles] = useState<Style[]>([]);

  useEffect(() => {
    void api
      .listStyles()
      .then((all) => setMyImageStyles(all.filter((x) => x.kind === "image")))
      .catch(() => {});
  }, []);

  /** AI 从全书摘要链搜集人物/地点/物品等设定 */
  const collect = async () => {
    if (collecting) return;
    setCollecting(true);
    setCollectMsg(null);
    setError(null);
    try {
      setCollectMsg(await api.collectLoreEntries(projectId));
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setCollecting(false);
    }
  };

  // 参考图缩略图：asset 协议直读磁盘（路径带时间戳，重生成即换新路径，无缓存问题）
  useEffect(() => {
    setThumbs((prev) => {
      const next = { ...prev };
      for (const e of entries) {
        if (e.ref_image) next[e.id] = api.fileUrl(e.ref_image);
      }
      return next;
    });
  }, [entries]);

  const generate = async (e: LoreEntry) => {
    if (busyId != null) return;
    setError(null);
    setBusyId(e.id);
    try {
      const path = await api.generateLoreRefImage(e.id, imgStyle);
      setThumbs((prev) => ({ ...prev, [e.id]: api.fileUrl(path) }));
      onChanged();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyId(null);
    }
  };

  if (entries.length === 0) {
    return (
      <div className="px-10 py-8">
        <p className="text-[13px] text-muted">
          还没有设定词条，到写作态侧栏「设定库」创建人物卡 / 地点 / 物品，或：
        </p>
        <button
          disabled={collecting}
          className="mt-3 rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
          onClick={() => void collect()}
        >
          {collecting ? "搜集中…" : "AI 从正文搜集设定"}
        </button>
        {collectMsg && <p className="mt-2 text-xs text-pgreen-t">{collectMsg}</p>}
        {error && <p className="mt-2 text-xs text-pred-t">{error}</p>}
      </div>
    );
  }

  // 出现的分类（固定顺序，未登记的不显示）
  const known = new Set<string>(LORE_CATEGORIES);
  const presentCats = LORE_CATEGORIES.filter((c) =>
    entries.some((e) => e.category === c || (c === "其他" && !known.has(e.category))),
  );

  // 筛选：分类页签 + 搜索（名称/内容/关键词）
  const q = query.trim().toLowerCase();
  const visible = entries.filter((e) => {
    const catOk =
      cat === "全部" ||
      e.category === cat ||
      (cat === "其他" && !known.has(e.category));
    if (!catOk) return false;
    if (!q) return true;
    return (
      e.title.toLowerCase().includes(q) ||
      e.content.toLowerCase().includes(q) ||
      e.keywords.toLowerCase().includes(q)
    );
  });
  const grouped = cat === "全部" && !q;
  const groups = grouped
    ? presentCats
        .map((c) => ({
          category: c,
          items: visible.filter(
            (e) => e.category === c || (c === "其他" && !known.has(e.category)),
          ),
        }))
        .filter((g) => g.items.length > 0)
    : [];

  const card = (e: LoreEntry) => (
    <div
      key={e.id}
      className="flex cursor-pointer gap-3 rounded-2xl bg-surface p-3 shadow-card transition-shadow hover:shadow-lift"
      onClick={() => setSelected(e)}
      title="查看详情"
    >
      <div className="h-24 w-[72px] shrink-0 overflow-hidden rounded-xl bg-card/60 shadow-card">
        {thumbs[e.id] ? (
          <img
            src={thumbs[e.id]}
            alt={e.title}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[10px] text-faint">
            无设定图
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-ink">
            {e.title}
          </span>
          {!grouped && (
            <span className="shrink-0 rounded-full bg-track px-1.5 py-px text-[10px] text-muted">
              {e.category}
            </span>
          )}
          {e.always_include && (
            <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-px text-[10px] font-medium text-accent">
              常驻
            </span>
          )}
        </div>
        <p className="mt-1 line-clamp-3 flex-1 text-[11px] leading-4 text-muted">
          {e.content || "（还没写内容）"}
        </p>
        <button
          disabled={busyId != null || !e.content.trim()}
          title={e.content.trim() ? "" : "先写点描述再生成"}
          className="mt-1.5 self-start rounded-full bg-accent/10 px-3 py-1 text-[11px] text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
          onClick={(ev) => {
            ev.stopPropagation();
            void generate(e);
          }}
        >
          {busyId === e.id
            ? "生成中…"
            : thumbs[e.id]
              ? "重新生成"
              : e.category === "人物"
                ? "生成三视图"
                : "生成设定图"}
        </button>
      </div>
    </div>
  );

  return (
    <div className="mx-auto max-w-[860px] px-8 py-4">
      <div className="flex items-center gap-3">
        <p className="text-[11px] leading-5 text-faint">
          设定图会作为参考图：视频分镜生图/图生视频命中该词条时自动携带（最多 3
          张），保证角色与场景跨镜一致
        </p>
        <button
          disabled={collecting}
          className="ml-auto shrink-0 rounded-full bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
          onClick={() => void collect()}
        >
          {collecting ? "搜集中…" : "AI 搜集设定"}
        </button>
      </div>
      {collectMsg && <p className="mt-2 text-xs text-pgreen-t">{collectMsg}</p>}
      {error && (
        <p className="mt-2 rounded-xl bg-pred px-3 py-2 text-xs text-pred-t">{error}</p>
      )}

      {/* 分类页签 + 搜索 */}
      <div className="mt-4 flex items-center gap-2">
        <div className="flex gap-1 rounded-[10px] bg-track p-[3px]">
          {["全部", ...presentCats].map((c) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                cat === c
                  ? "bg-surface text-ink shadow-card"
                  : "text-muted hover:text-body"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
        <select
          className="ml-auto rounded-[10px] bg-card/60 px-2.5 py-1.5 text-[12px] text-body shadow-card outline-none focus:bg-surface"
          value={imgStyle}
          onChange={(e) => setImgStyle(e.target.value)}
          title="生成设定图时追加的画风"
        >
          <option value="">画风：默认</option>
          {[
            ...IMAGE_PRESETS.map((p) => ({ key: `p:${p.name}`, ...p })),
            ...myImageStyles.map((x) => ({
              key: `u:${x.id}`,
              name: x.name,
              guide: x.guide,
            })),
          ].map((o) => (
            <option key={o.key} value={o.guide}>
              画风：{o.name}
            </option>
          ))}
        </select>
        <input
          className="w-52 rounded-[10px] bg-card/60 px-3 py-1.5 text-[12px] shadow-card outline-none placeholder:text-faint focus:bg-surface"
          placeholder="搜索名称 / 内容 / 关键词"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {visible.length === 0 ? (
        <p className="py-10 text-center text-[13px] text-faint">
          没有匹配的词条
        </p>
      ) : grouped ? (
        groups.map((g) => (
          <div key={g.category} className="mt-5">
            <p className="text-xs font-semibold text-muted">
              {g.category}
              <span className="ml-1.5 font-normal text-faint">{g.items.length}</span>
            </p>
            <div className="mt-2 grid grid-cols-2 gap-3">
              {g.items.map(card)}
            </div>
          </div>
        ))
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-3">{visible.map(card)}</div>
      )}

      {/* 词条详情：大图 + 完整信息 */}
      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => setSelected(null)}
        >
          <div
            className="mx-4 flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-surface shadow-float"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-5 pt-4">
              <span className="truncate text-[15px] font-bold text-ink">
                {selected.title}
              </span>
              <span className="shrink-0 rounded-full bg-track px-2 py-0.5 text-[10px] text-muted">
                {selected.category}
              </span>
              {selected.always_include && (
                <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent">
                  常驻注入
                </span>
              )}
              <button
                className="ml-auto text-faint hover:text-body"
                onClick={() => setSelected(null)}
              >
                ×
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-5">
              <div className="overflow-hidden rounded-xl bg-card/60 shadow-card">
                {thumbs[selected.id] ? (
                  <img
                    src={thumbs[selected.id]}
                    alt={selected.title}
                    className="max-h-[42vh] w-full object-cover"
                  />
                ) : (
                  <div className="flex h-40 items-center justify-center text-xs text-faint">
                    还没有设定图
                  </div>
                )}
              </div>
              <button
                disabled={busyId != null || !selected.content.trim()}
                className="mt-3 rounded-full bg-accent/10 px-3.5 py-1.5 text-[12px] text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
                onClick={() => void generate(selected)}
              >
                {busyId === selected.id
                  ? "生成中…"
                  : thumbs[selected.id]
                    ? "重新生成设定图"
                    : selected.category === "人物"
                      ? "生成三视图"
                      : "生成设定图"}
              </button>
              {selected.keywords.trim() && (
                <p className="mt-3 text-[11px] text-faint">
                  触发关键词：{selected.keywords}
                </p>
              )}
              <p className="mt-3 text-[13.5px] leading-7 whitespace-pre-wrap text-body">
                {selected.content || "（还没写内容）"}
              </p>
              <p className="mt-4 text-[11px] text-faint">
                需要修改内容请去写作态侧栏「设定库」编辑
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
