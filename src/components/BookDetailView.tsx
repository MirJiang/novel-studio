import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { IMAGE_PRESETS } from "../lib/stylePresets";
import { LORE_CATEGORIES, type LoreChange, type LoreEntry, type LoreRelation, type Project, type Style } from "../types";
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

/** 设定页签：左右分栏——左侧分类+搜索+词条列表，右侧选中词条详情（内容/设定图/变更时间线/人物资产） */
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
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [exCollecting, setExCollecting] = useState(false);
  const [exProgress, setExProgress] = useState<string | null>(null);
  const [collectMsg, setCollectMsg] = useState<string | null>(null);
  const [cat, setCat] = useState("全部");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"list" | "graph">("list"); // 词条列表 / 关系网络总览
  const [imgStyle, setImgStyle] = useState(""); // 设定图画风锚点词
  const [myImageStyles, setMyImageStyles] = useState<Style[]>([]);

  useEffect(() => {
    void api
      .listStyles()
      .then((all) => setMyImageStyles(all.filter((x) => x.kind === "image")))
      .catch(() => {});
  }, []);

  /** AI 从全书摘要链搜集人物/地点/物品等设定（快，只收重要的） */
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

  /** 穷尽式收集：逐章扫正文，所有出现过的具体元素都收（含一把无关紧要的小刀），带进度 */
  const collectExhaustive = async () => {
    if (exCollecting) return;
    setExCollecting(true);
    setExProgress("准备中…");
    setCollectMsg(null);
    setError(null);
    try {
      setCollectMsg(
        await api.collectLoreExhaustive(projectId, (ev) => {
          if (ev.type === "progress") setExProgress(ev.label);
        }),
      );
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setExCollecting(false);
      setExProgress(null);
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

  // 选中词条跟随列表刷新；没选中时默认开第一个可见词条
  const selected = entries.find((e) => e.id === selectedId) ?? null;

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
      <div className="mx-auto max-w-[720px] px-8 py-8">
        <p className="text-[13px] text-muted">
          还没有设定词条，到写作态侧栏「设定库」创建人物卡 / 地点 / 物品，或：
        </p>
        <div className="mt-3 flex gap-2">
          <button
            disabled={collecting || exCollecting}
            className="rounded-full bg-card/70 px-4 py-2 text-[13px] text-body shadow-card transition-colors hover:bg-surface disabled:opacity-40"
            onClick={() => void collect()}
          >
            {collecting ? "搜集中…" : "AI 搜集设定（摘要链，快）"}
          </button>
          <button
            disabled={collecting || exCollecting}
            className="rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
            onClick={() => void collectExhaustive()}
          >
            {exCollecting ? "扫描中…" : "全面搜集（逐章，含次要物品）"}
          </button>
        </div>
        {exProgress && (
          <p className="mt-2 text-xs text-accent">{exProgress}</p>
        )}
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

  /** 左列紧凑词条行：小缩略图 + 名称/分类 + 内容两行 */
  const row = (e: LoreEntry) => (
    <button
      key={e.id}
      onClick={() => setSelectedId(e.id)}
      className={`flex w-full items-center gap-2.5 rounded-xl p-2.5 text-left transition-colors ${
        selectedId === e.id
          ? "bg-surface shadow-card ring-1 ring-accent/40"
          : "hover:bg-hover"
      }`}
    >
      <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-card/60 shadow-card">
        {thumbs[e.id] ? (
          <img src={thumbs[e.id]} alt={e.title} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[9px] text-faint">
            {e.category}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-ink">{e.title}</span>
          {e.always_include && (
            <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-px text-[9px] font-medium text-accent">
              常驻
            </span>
          )}
        </div>
        <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted">
          {e.content || "（还没写内容）"}
        </p>
      </div>
    </button>
  );

  return (
    <div className="mx-auto flex h-full max-w-[1240px] min-w-0 flex-col px-8 py-4">
      {/* 视图切换：词条列表 / 关系网络 */}
      <div className="flex shrink-0 items-center gap-3">
        <div className="flex gap-1 rounded-[10px] bg-track p-[3px]">
          {(
            [
              ["list", "词条"],
              ["graph", "关系网络"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                view === v
                  ? "bg-surface text-ink shadow-card"
                  : "text-muted hover:text-body"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-faint">
          {view === "graph"
            ? "写作时自动提取的人物/物品/功法关系（点击名字跳转词条）"
            : "设定图会作为参考图：视频分镜生图/图生视频命中该词条时自动携带（最多 3 张）"}
        </p>
      </div>

      {view === "graph" ? (
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
          <LoreRelationsView
            projectId={projectId}
            entries={entries}
            onSelect={(id) => {
              setSelectedId(id);
              setView("list");
            }}
          />
        </div>
      ) : (
        <div className="mt-3 flex min-h-0 flex-1 gap-4">
          {/* 左：工具栏 + 词条列表 */}
          <div className="flex min-h-0 w-[380px] shrink-0 flex-col">
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="flex flex-wrap gap-1 rounded-[10px] bg-track p-[3px]">
                {["全部", ...presentCats].map((c) => (
                  <button
                    key={c}
                    onClick={() => setCat(c)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      cat === c
                        ? "bg-surface text-ink shadow-card"
                        : "text-muted hover:text-body"
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
              <input
                className="ml-auto w-40 rounded-[10px] bg-card/60 px-2.5 py-1.5 text-[12px] shadow-card outline-none placeholder:text-faint focus:bg-surface"
                placeholder="搜索名称 / 内容 / 关键词"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            <div className="mt-2.5 flex items-center gap-2">
              <button
                disabled={collecting || exCollecting}
                className="rounded-full bg-card/70 px-3 py-1.5 text-[12px] text-body shadow-card transition-colors hover:bg-surface disabled:opacity-40"
                onClick={() => void collect()}
              >
                {collecting ? "搜集中…" : "AI 搜集（快）"}
              </button>
              <button
                disabled={collecting || exCollecting}
                title="逐章扫正文，所有出现过的具体元素都收——哪怕一把无关紧要的小刀"
                className="rounded-full bg-accent px-3 py-1.5 text-[12px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h disabled:opacity-40"
                onClick={() => void collectExhaustive()}
              >
                {exCollecting ? "扫描中…" : "全面搜集"}
              </button>
            </div>
            {exProgress && (
              <p className="mt-2 truncate rounded-xl bg-accent-soft px-3 py-2 text-xs text-accent">
                {exProgress}
              </p>
            )}
            {collectMsg && !exProgress && (
              <p className="mt-2 text-xs leading-5 text-pgreen-t">{collectMsg}</p>
            )}
            {error && (
              <p className="mt-2 rounded-xl bg-pred px-3 py-2 text-xs text-pred-t">{error}</p>
            )}

            <div className="mt-2.5 min-h-0 flex-1 overflow-y-auto pr-1">
              {visible.length === 0 ? (
                <p className="py-10 text-center text-[13px] text-faint">没有匹配的词条</p>
              ) : grouped ? (
                groups.map((g) => (
                  <div key={g.category} className="mb-3">
                    <p className="px-2.5 pb-1 text-xs font-semibold text-muted">
                      {g.category}
                      <span className="ml-1.5 font-normal text-faint">{g.items.length}</span>
                    </p>
                    <div className="flex flex-col gap-1">{g.items.map(row)}</div>
                  </div>
                ))
              ) : (
                <div className="flex flex-col gap-1">{visible.map(row)}</div>
              )}
            </div>
          </div>

          {/* 右：选中词条详情（内容 + 变更时间线 + 人物资产） */}
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            {selected ? (
              <LoreDetailPanel
                key={selected.id}
                projectId={projectId}
                entry={selected}
                entries={entries}
                thumbs={thumbs}
                busy={busyId === selected.id}
                anyBusy={busyId != null}
                onSelect={setSelectedId}
                onGenerate={() => void generate(selected)}
                imgStyle={imgStyle}
                onImgStyle={setImgStyle}
                imageStyles={[
                  ...IMAGE_PRESETS.map((p) => ({ key: `p:${p.name}`, ...p })),
                  ...myImageStyles.map((x) => ({
                    key: `u:${x.id}`,
                    name: x.name,
                    guide: x.guide,
                  })),
                ]}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-faint">
                左侧点一个词条查看详情
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 关系网络总览：按主体分组，谓词 + 对象成片；点击名字跳词条 */
function LoreRelationsView({
  projectId,
  entries,
  onSelect,
}: {
  projectId: number;
  entries: LoreEntry[];
  onSelect: (id: number) => void;
}) {
  const [relations, setRelations] = useState<LoreRelation[] | null>(null);

  useEffect(() => {
    setRelations(null);
    void api
      .listLoreRelations(projectId)
      .then(setRelations)
      .catch(() => setRelations([]));
  }, [projectId]);

  const groups = useMemo(() => {
    const map = new Map<string, LoreRelation[]>();
    for (const r of relations ?? []) {
      if (!map.has(r.subject)) map.set(r.subject, []);
      map.get(r.subject)!.push(r);
    }
    return [...map.entries()] as [string, LoreRelation[]][];
  }, [relations]);

  const byTitle = (title: string) => entries.find((e) => e.title === title);

  const nameBtn = (title: string, cls: string) => {
    const e = byTitle(title);
    return e ? (
      <button
        onClick={() => onSelect(e.id)}
        className={`transition-colors hover:underline ${cls}`}
      >
        {title}
      </button>
    ) : (
      <span className={cls}>{title}</span>
    );
  };

  if (relations == null) {
    return <p className="py-10 text-center text-sm text-faint">关系加载中…</p>;
  }
  if (groups.length === 0) {
    return (
      <p className="py-10 text-center text-[13px] leading-6 text-faint">
        还没有关系记录——写章后自动提取，或在台账页「提取本章变更」；
        <br />
        也可以在批量写章弹层确认「收尾自动应用设定变更」已开启
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3 pb-6">
      {groups.map(([subject, rels]) => (
        <div key={subject} className="rounded-2xl bg-surface p-4 shadow-card">
          <p className="text-[13px] font-semibold text-ink">
            {nameBtn(subject, "hover:text-accent")}
            <span className="ml-2 text-[11px] font-normal text-faint">
              {rels.length} 条关系
            </span>
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {rels.map((r, i) => (
              <span
                key={i}
                className="flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1.5 text-[12px] shadow-card"
              >
                <span className="rounded-full bg-accent-soft px-1.5 py-px text-[10px] text-accent">
                  {r.predicate}
                </span>
                <span className="text-faint">第{r.chapter_order}章</span>
                {nameBtn(r.object, "font-medium text-ink hover:text-accent")}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 变更 kind → 展示 */
const CHANGE_KIND: Record<string, { label: string; cls: string }> = {
  new: { label: "登场", cls: "bg-pgreen text-pgreen-t" },
  update: { label: "变更", cls: "bg-pyellow text-pyellow-t" },
  retire: { label: "退场", cls: "bg-pred text-pred-t" },
};

/** 右栏：单个词条的完整详情——设定图 + 内容 + 变更时间线 + 人物资产（物品/功法） */
function LoreDetailPanel({
  projectId,
  entry,
  entries,
  thumbs,
  busy,
  anyBusy,
  onSelect,
  onGenerate,
  imgStyle,
  onImgStyle,
  imageStyles,
}: {
  projectId: number;
  entry: LoreEntry;
  entries: LoreEntry[];
  thumbs: Record<number, string>;
  busy: boolean;
  anyBusy: boolean;
  onSelect: (id: number) => void;
  onGenerate: () => void;
  imgStyle: string;
  onImgStyle: (v: string) => void;
  imageStyles: { key: string; name: string; guide: string }[];
}) {
  const [changes, setChanges] = useState<LoreChange[] | null>(null);
  const [relations, setRelations] = useState<LoreRelation[] | null>(null);

  useEffect(() => {
    setChanges(null);
    setRelations(null);
    void api
      .listLoreChanges(projectId)
      .then(setChanges)
      .catch(() => setChanges([]));
    void api
      .listLoreRelations(projectId)
      .then(setRelations)
      .catch(() => setRelations([]));
  }, [projectId, entry.id]);

  // 本词条的时间线（按章节正序）
  const timeline = (changes ?? [])
    .filter((c) => c.entry_id === entry.id || c.entry_title === entry.title)
    .slice()
    .reverse();

  // 人物资产（关系表优先，旧数据无关系时退回字符串匹配）：
  // 正向 = 该角色 拥有/使用/师承… 的物品功法；反向 = 谁拥有/使用 本词条（物品词条可查持有者）
  const forwardRels = (relations ?? []).filter(
    (r) => r.subject === entry.title && r.object !== entry.title,
  );
  const backwardRels = (relations ?? []).filter(
    (r) => r.object === entry.title && r.subject !== entry.title,
  );
  const relatedByMatch =
    changes != null && relations != null && relations.length === 0
      ? entry.category === "人物"
        ? entries.filter((x) => {
            if (x.id === entry.id || x.category === "人物" || x.category === "地点") {
              return false;
            }
            if (x.content.includes(entry.title) || x.keywords.includes(entry.title)) {
              return true;
            }
            return changes.some(
              (c) =>
                (c.entry_id === x.id || c.entry_title === x.title) &&
                c.detail.includes(entry.title),
            );
          })
        : []
      : [];
  // 关系命中的词条（可点击跳转）
  const entriesByTitle = (title: string) =>
    entries.find((x) => x.title === title);
  const related =
    forwardRels.length > 0 || backwardRels.length > 0 || relatedByMatch.length > 0
      ? {
          forward: forwardRels
            .map((r) => ({ rel: r, entry: entriesByTitle(r.object) }))
            .filter((x) => x.entry != null),
          backward: backwardRels
            .map((r) => ({ rel: r, entry: entriesByTitle(r.subject) }))
            .filter((x) => x.entry != null),
          fallback: relatedByMatch,
        }
      : null;

  return (
    <div className="pb-6">
      {/* 头部 */}
      <div className="flex items-center gap-2">
        <span className="text-[17px] font-bold text-ink">{entry.title}</span>
        <span className="shrink-0 rounded-full bg-track px-2 py-0.5 text-[10px] text-muted">
          {entry.category}
        </span>
        {entry.always_include && (
          <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent">
            常驻注入
          </span>
        )}
        {!entry.enabled && (
          <span className="shrink-0 rounded-full bg-pred/10 px-2 py-0.5 text-[10px] text-pred-t">
            已停用
          </span>
        )}
        <select
          className="ml-auto shrink-0 rounded-[10px] bg-card/60 px-2 py-1.5 text-[12px] text-body shadow-card outline-none focus:bg-surface"
          value={imgStyle}
          onChange={(e) => onImgStyle(e.target.value)}
          title="生成设定图时追加的画风"
        >
          <option value="">画风：默认</option>
          {imageStyles.map((o) => (
            <option key={o.key} value={o.guide}>
              画风：{o.name}
            </option>
          ))}
        </select>
        <button
          disabled={anyBusy || !entry.content.trim()}
          className="shrink-0 rounded-full bg-accent/10 px-3.5 py-1.5 text-[12px] text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
          onClick={onGenerate}
        >
          {busy
            ? "生成中…"
            : thumbs[entry.id]
              ? "重新生成设定图"
              : entry.category === "人物"
                ? "生成三视图"
                : "生成设定图"}
        </button>
      </div>

      <div className="mt-3 grid grid-cols-[220px_1fr] gap-4">
        {/* 左：设定图 */}
        <div>
          <div className="overflow-hidden rounded-xl bg-card/60 shadow-card">
            {thumbs[entry.id] ? (
              <img
                src={thumbs[entry.id]}
                alt={entry.title}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-40 items-center justify-center text-xs text-faint">
                还没有设定图
              </div>
            )}
          </div>
          <p className="mt-2 text-[10px] leading-4 text-faint">
            设定图会作为参考图：视频分镜生图/图生视频命中该词条时自动携带（最多 3 张）
          </p>
        </div>

        {/* 右：内容 + 关键词 */}
        <div className="min-w-0">
          {entry.keywords.trim() && (
            <p className="text-[11px] text-faint">触发关键词：{entry.keywords}</p>
          )}
          <p className="mt-1.5 whitespace-pre-wrap text-[13.5px] leading-7 text-body">
            {entry.content || "（还没写内容）"}
          </p>
          <p className="mt-3 text-[11px] text-faint">
            需要修改内容请去写作态侧栏「设定库」编辑
          </p>
        </div>
      </div>

      {/* 关系网络：人物看拥有/关联（正向），物品功法看持有者/使用者（反向） */}
      {related && (
        <div className="mt-5">
          <p className="text-xs font-semibold text-muted">
            {entry.category === "人物" ? "拥有 / 关联" : "持有者 / 关联"}
            <span className="ml-1.5 font-normal text-faint">
              {related.forward.length + related.backward.length + related.fallback.length} 条
              （写作时自动提取的关系）
            </span>
          </p>
          {related.forward.length === 0 &&
          related.backward.length === 0 &&
          related.fallback.length === 0 ? (
            <p className="mt-2 text-[12px] text-faint">
              还没有关系记录——写章后自动提取，或在台账页「提取本章变更」
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {related.forward.map(({ rel, entry: x }) => (
                <button
                  key={`f-${rel.chapter_id}-${x!.id}`}
                  onClick={() => onSelect(x!.id)}
                  title={x!.content}
                  className="flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1.5 text-[12px] shadow-card transition-colors hover:bg-surface2"
                >
                  <span className="rounded-full bg-accent-soft px-1.5 py-px text-[10px] text-accent">
                    {rel.predicate}
                  </span>
                  <span className="font-medium text-ink">{x!.title}</span>
                </button>
              ))}
              {related.backward.map(({ rel, entry: x }) => (
                <button
                  key={`b-${rel.chapter_id}-${x!.id}`}
                  onClick={() => onSelect(x!.id)}
                  title={x!.content}
                  className="flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1.5 text-[12px] shadow-card transition-colors hover:bg-surface2"
                >
                  <span className="text-[11px] text-faint">被{rel.predicate}于</span>
                  <span className="font-medium text-ink">{x!.title}</span>
                </button>
              ))}
              {related.fallback.map((x) => (
                <button
                  key={`m-${x.id}`}
                  onClick={() => onSelect(x.id)}
                  title={x.content}
                  className="flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1.5 text-[12px] shadow-card transition-colors hover:bg-surface2"
                >
                  <span className="rounded-full bg-track px-1.5 py-px text-[10px] text-muted">
                    {x.category}
                  </span>
                  <span className="font-medium text-ink">{x.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 变更时间线 */}
      <div className="mt-5">
        <p className="text-xs font-semibold text-muted">
          变更时间线
          <span className="ml-1.5 font-normal text-faint">
            {changes == null ? "加载中…" : `${timeline.length} 条`}
          </span>
        </p>
        {timeline.length === 0 ? (
          <p className="mt-2 text-[12px] text-faint">
            {changes == null
              ? ""
              : "还没有变更记录——生成章节摘要时会自动提取，也可在「变更台账」手动提取"}
          </p>
        ) : (
          <div className="mt-2 flex flex-col gap-1.5">
            {timeline.map((c) => {
              const meta = CHANGE_KIND[c.kind] ?? CHANGE_KIND.update;
              return (
                <div
                  key={c.id}
                  className="flex items-baseline gap-2 rounded-xl bg-canvas px-3 py-2"
                >
                  <span className="shrink-0 text-[11px] text-faint">
                    {c.chapter_title}
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium ${meta.cls}`}
                  >
                    {meta.label}
                  </span>
                  <span className="min-w-0 text-[12px] leading-5 text-body">
                    {c.detail}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
