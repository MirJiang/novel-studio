import { useCallback, useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "./lib/api";
import { applyUiPrefs } from "./lib/uiPrefs";
import type { BootstrapDraft, Chapter, ChapterMeta, LoreEntry, OutlineItem, Project, Task } from "./types";
import { Caption } from "./components/Caption";
import { AppRail } from "./components/AppRail";
import { Sidebar } from "./components/Sidebar";
import { Editor } from "./components/Editor";
import { LoreEditor } from "./components/LoreEditor";
import { LoreLedgerView } from "./components/LoreLedgerView";
import { CoverView } from "./components/CoverView";
import { CheckView } from "./components/CheckView";
import { VideoView } from "./components/VideoView";
import { PublishView } from "./components/PublishView";
import { TasksView } from "./components/TasksView";
import { OutlineView } from "./components/OutlineView";
import { SettingsView } from "./components/SettingsView";
import { StylesView } from "./components/StylesView";
import { Bookshelf } from "./components/Bookshelf";
import { BookDetailView } from "./components/BookDetailView";
import { AICreateWizard } from "./components/AICreateWizard";
import { AssistantPanel } from "./components/AssistantPanel";
import {
  BatchWriteDialog,
  type BatchStartOptions,
} from "./components/BatchWriteDialog";

/** 主视图：写章节 / 编辑设定 / 封面工坊 / 全书体检 */
type View =
  | { kind: "chapter"; chapter: Chapter; initialScroll?: number }
  | { kind: "lore"; entry: LoreEntry }
  | { kind: "loreLedger" }
  | { kind: "outline" }
  | { kind: "cover" }
  | { kind: "check" }
  | { kind: "video" }
  | { kind: "publish" }
  | null;

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<number | null>(null);
  /** 最近打开的书：回书架不清空，体检/视频/发布在书架也能带着它直达 */
  const [lastProjectId, setLastProjectId] = useState<number | null>(null);
  /** 从书架直达到目标工坊：项目切换 effect 会重置视图，用它把目标视图带过去 */
  const pendingViewRef = useRef<View>(null);
  /** 工坊选书面板：点体检/视频/发布但没有任何书上下文时，让用户挑一本 */
  const [workshopPicker, setWorkshopPicker] = useState<View>(null);
  const [chapters, setChapters] = useState<ChapterMeta[]>([]);
  const [loreEntries, setLoreEntries] = useState<LoreEntry[]>([]);
  const [outlineItems, setOutlineItems] = useState<OutlineItem[]>([]);
  const [view, setView] = useState<View>(null);
  const [settingsOpen, setSettingsOpen] = useState(false); // 设置页（整页路由，非弹窗）
  const [stylesOpen, setStylesOpen] = useState(false); // 风格库（整页路由，全局）
  const [detailId, setDetailId] = useState<number | null>(null); // 书籍详情覆盖层（书架 ⋯ 菜单）
  const [wizardOpen, setWizardOpen] = useState(false); // AI 起书向导（覆盖层，常驻挂载不丢对话）
  const [wizardEverOpened, setWizardEverOpened] = useState(false);
  const [wizardEpoch, setWizardEpoch] = useState(0); // 创建成功后 +1 重置对话
  const [wizardFresh, setWizardFresh] = useState(false); // 重置后首挂跳过会话恢复
  const [assistantOpen, setAssistantOpen] = useState(false); // 写作助手抽屉
  const [assistantEverOpened, setAssistantEverOpened] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    void applyUiPrefs(); // 主题/编辑器字体
    api.listProjects().then(setProjects).catch(console.error);
    // 恢复最近打开的书（体检/视频/发布从书架直达用）
    void api.getSetting("last_project").then((v) => {
      const id = v ? parseInt(v, 10) : NaN;
      if (Number.isFinite(id)) setLastProjectId(id);
    });
  }, []);

  const refreshChapters = useCallback(async (projectId: number) => {
    try {
      setChapters(await api.listChapters(projectId));
    } catch (e) {
      console.error(e);
    }
  }, []);

  const refreshLore = useCallback(async (projectId: number) => {
    try {
      setLoreEntries(await api.listLoreEntries(projectId));
    } catch (e) {
      console.error(e);
    }
  }, []);

  const refreshOutline = useCallback(async (projectId: number) => {
    try {
      setOutlineItems(await api.listOutline(projectId));
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    if (currentProjectId == null) {
      setChapters([]);
      setLoreEntries([]);
      setOutlineItems([]);
      setView(null);
      return;
    }
    setLastProjectId(currentProjectId);
    void api.setSetting("last_project", String(currentProjectId));
    void refreshChapters(currentProjectId);
    void refreshLore(currentProjectId);
    void refreshOutline(currentProjectId);
    const pending = pendingViewRef.current;
    pendingViewRef.current = null;
    setView(pending);
  }, [currentProjectId, refreshChapters, refreshLore, refreshOutline]);

  // ---------- 作品 ----------

  const handleCreateProject = async (
    name: string,
    targetTotalWords?: number,
    targetChapterWords?: number,
    styleId?: number
  ) => {
    const p = await api.createProject(
      name,
      undefined,
      targetTotalWords,
      targetChapterWords,
      styleId
    );
    setProjects((prev) => [p, ...prev]);
    setCurrentProjectId(p.id); // 建完直接进入
  };

  const handleRenameProject = async (id: number, name: string) => {
    await api.renameProject(id, name);
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p)));
  };

  const handleDeleteProject = async (id: number) => {
    await api.deleteProject(id);
    setProjects((prev) => prev.filter((p) => p.id !== id));
  };

  /** AI 起书：草稿确认后落库（作品 + 简介 + 初始设定词条），直接进入 */
  const handleAiCreate = async (draft: BootstrapDraft) => {
    try {
      const p = await api.createProject(
        draft.name,
        draft.description,
        draft.target_total_words,
        draft.target_chapter_words,
        draft.style_id
      );
      for (const l of draft.lore) {
        const e = await api.createLoreEntry(p.id, l.title, l.category);
        await api.updateLoreEntry({
          ...e,
          content: l.content,
          keywords: l.keywords,
          always_include: l.always_include,
        });
      }
      if (draft.synopsis.trim()) {
        await api.saveProjectInfo(p.id, draft.description, draft.synopsis);
        p.synopsis = draft.synopsis;
      }
      // 整体流程步骤落库为大纲节点（进度追踪 + 续写注入；带按剧情预估的各卷章数）
      let outlineCount = 0;
      for (const o of draft.outline ?? []) {
        if (!o.title.trim()) continue;
        const it = await api.addOutlineItem(p.id, o.title);
        await api.saveOutlineItem(it.id, o.title, o.content, o.target_chapters ?? 0);
        outlineCount++;
      }
      setProjects((prev) => [p, ...prev]);
      setCurrentProjectId(p.id);
      showToast(
        `《${p.name}》已创建：${draft.lore.length} 条设定${outlineCount ? `、${outlineCount} 个大纲节点` : ""}`
      );
    } catch (e) {
      showToast(`创建失败：${String(e)}`);
    }
  };

  // ---------- 章节 ----------

  const handleCreateChapter = async () => {
    if (currentProjectId == null) return;
    const title = `第 ${chapters.length + 1} 章`;
    const c = await api.createChapter(currentProjectId, title);
    await refreshChapters(currentProjectId);
    setView({ kind: "chapter", chapter: c });
  };

  const handleSelectChapter = async (id: number, initialScroll?: number) => {
    try {
      setView({ kind: "chapter", chapter: await api.getChapter(id), initialScroll });
    } catch (e) {
      console.error(e);
    }
  };

  // ---------- 阅读位置记忆（每本书一条 settings 记录） ----------

  const posKey = (pid: number) => `pos_${pid}`;

  /** 编辑器节流/卸载时上报：记住这本书最后停在哪章哪屏 */
  const handleScrollPos = (chapterId: number, top: number) => {
    if (currentProjectId == null) return;
    void api.setSetting(
      posKey(currentProjectId),
      JSON.stringify({ chapter_id: chapterId, scroll: top })
    );
  };

  // ---------- 任务队列（App 层轮询：浮条 / toast / 章节实时刷新） ----------

  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const taskPrevRef = useRef<Map<number, { status: string; pc: number }>>(new Map());
  // 轮询回调是闭包，切作品后要用 ref 判断前台还是不是同一本书
  const currentProjectIdRef = useRef<number | null>(null);
  useEffect(() => {
    currentProjectIdRef.current = currentProjectId;
  }, [currentProjectId]);

  const pollTasks = useCallback(async () => {
    try {
      const list = await api.listTasks();
      const prev = taskPrevRef.current;
      for (const t of list) {
        const before = prev.get(t.id);
        const wasActive =
          before?.status === "pending" || before?.status === "running";
        const active = t.status === "pending" || t.status === "running";
        // 完成态跃迁：toast + 批量写章要刷新章节/大纲
        if (wasActive && !active) {
          if (t.status === "done") {
            showToast(`${t.label}：${t.result || "完成"}`);
          } else if (t.status === "cancelled") {
            showToast(`${t.label}：已取消${t.result ? `（${t.result}）` : ""}`);
          } else {
            showToast(`${t.label} 失败：${t.error}`);
          }
          if (
            t.kind === "batch_chapters" &&
            currentProjectIdRef.current === t.project_id
          ) {
            void refreshChapters(t.project_id);
            void refreshOutline(t.project_id); // 大纲节点可能已被自动推进
          }
        }
        // 进行中的批量写章：进度前进就实时刷新章节列表
        if (
          t.kind === "batch_chapters" &&
          t.status === "running" &&
          t.progress_current > 0 &&
          before?.pc !== t.progress_current &&
          currentProjectIdRef.current === t.project_id
        ) {
          void refreshChapters(t.project_id);
        }
        prev.set(t.id, { status: t.status, pc: t.progress_current });
      }
      setTasks((old) =>
        JSON.stringify(old) === JSON.stringify(list) ? old : list
      );
    } catch {
      /* 轮询失败下轮再来 */
    }
  }, [refreshChapters, refreshOutline, showToast]);

  useEffect(() => {
    void pollTasks();
    const timer = window.setInterval(() => void pollTasks(), 2000);
    return () => window.clearInterval(timer);
  }, [pollTasks]);

  /** 当前作品进行中/排队中的批量写章任务 */
  const activeBatch =
    tasks.find(
      (t) =>
        t.kind === "batch_chapters" &&
        t.project_id === currentProjectId &&
        (t.status === "pending" || t.status === "running")
    ) ?? null;
  const runningTask = tasks.find((t) => t.status === "running") ?? null;
  const tasksRunning = tasks.some(
    (t) => t.status === "running" || t.status === "pending"
  );

  const handleBatchStart = async (project: Project, o: BatchStartOptions) => {
    // 字数目标有改动先落库（作品级记忆，下次直接带出）
    try {
      if (
        o.totalWords !== project.target_total_words ||
        o.chapterWords !== project.target_chapter_words
      ) {
        await api.updateProjectTargets(project.id, o.totalWords, o.chapterWords);
        void api.listProjects().then(setProjects);
      }
      await api.enqueueBatchChapters(project.id, o.chapterCount, o.wordsPerChapter);
      showToast("已加入任务队列");
      void pollTasks();
    } catch (e) {
      showToast(String(e));
    }
  };

  /** 最小化弹层：任务在队列里继续跑，右下角浮条显示进度 */
  const handleBatchMinimize = () => setBatchOpen(false);

  /** 取消批量任务：当前章写完后停下 */
  const handleBatchCancel = (taskId: number) => {
    void api.cancelTask(taskId).then(() => pollTasks());
  };

  /** 关闭弹层 */
  const handleBatchClose = () => {
    setBatchOpen(false);
    if (currentProjectId != null) void refreshChapters(currentProjectId);
    void api.listProjects().then(setProjects); // 字数目标可能在弹层里改过
  };

  const handleDeleteChapter = async (id: number) => {
    if (!window.confirm("确定删除这个章节吗？此操作不可恢复。")) return;
    await api.deleteChapter(id);
    if (view?.kind === "chapter" && view.chapter.id === id) setView(null);
    if (currentProjectId != null) await refreshChapters(currentProjectId);
  };

  // ---------- 设定库 ----------

  const handleCreateLore = async () => {
    if (currentProjectId == null) return;
    const e = await api.createLoreEntry(currentProjectId, "未命名词条", "人物");
    await refreshLore(currentProjectId);
    setView({ kind: "lore", entry: e });
  };

  const handleSelectLore = (id: number) => {
    const entry = loreEntries.find((e) => e.id === id);
    if (entry) setView({ kind: "lore", entry });
  };

  const handleDeleteLore = async (id: number) => {
    if (!window.confirm("确定删除这条设定吗？")) return;
    await api.deleteLoreEntry(id);
    if (view?.kind === "lore" && view.entry.id === id) setView(null);
    if (currentProjectId != null) await refreshLore(currentProjectId);
  };

  const handleChapterSaved = useCallback(() => {
    if (currentProjectId != null) void refreshChapters(currentProjectId);
  }, [currentProjectId, refreshChapters]);

  const handleLoreSaved = useCallback(() => {
    if (currentProjectId != null) void refreshLore(currentProjectId);
  }, [currentProjectId, refreshLore]);

  const currentChapterId = view?.kind === "chapter" ? view.chapter.id : null;
  const currentLoreId = view?.kind === "lore" ? view.entry.id : null;

  /** 进整页工坊（体检/视频/发布）：在书内直接切；在书架则带最近打开的书直达 */
  const goWorkshop = (target: View) => {
    setSettingsOpen(false);
    setStylesOpen(false);
    setTasksOpen(false);
    if (currentProjectId != null) {
      setView(target);
    } else if (
      lastProjectId != null &&
      projects.some((p) => p.id === lastProjectId)
    ) {
      pendingViewRef.current = target;
      setCurrentProjectId(lastProjectId);
    } else {
      setWorkshopPicker(target); // 没有上下文：挑一本再进
    }
  };

  /** 工坊页内切换作品：换书但停在当前工坊视图 */
  const switchWorkshopProject = (id: number) => {
    if (id === currentProjectId) return;
    pendingViewRef.current = view;
    setCurrentProjectId(id);
  };

  /** 从书架进入作品：恢复上次的阅读位置（章节 + 滚动位置），没存过则打开最新一章 */
  const handleOpenProject = async (id: number) => {
    setCurrentProjectId(id);
    const list = await api.listChapters(id);
    if (list.length === 0) return; // 零章节新书停在空状态页（有批量写章入口）
    let chapterId = list[list.length - 1].id;
    let scroll = 0;
    try {
      const raw = await api.getSetting(posKey(id));
      if (raw) {
        const pos = JSON.parse(raw) as { chapter_id: number; scroll: number };
        if (list.some((c) => c.id === pos.chapter_id)) {
          chapterId = pos.chapter_id;
          scroll = pos.scroll || 0;
        }
      }
    } catch {
      /* 位置数据损坏当没存过 */
    }
    void handleSelectChapter(chapterId, scroll);
  };

  /** 写作助手悬浮球是否可用：写作态（章节/设定/大纲/写作空页）且不在整页路由里 */
  const assistantVisible =
    currentProjectId != null &&
    !settingsOpen &&
    !stylesOpen &&
    !tasksOpen &&
    !wizardOpen &&
    (view == null ||
      view.kind === "chapter" ||
      view.kind === "lore" ||
      view.kind === "loreLedger" ||
      view.kind === "outline");

  /** 改写替换成功：刷新列表 + 重载当前章节（updated_at 变化触发编辑器重挂载） */
  const handleChapterReplaced = async (chapterId: number) => {
    if (currentProjectId == null) return;
    await refreshChapters(currentProjectId);
    if (view?.kind === "chapter" && view.chapter.id === chapterId) {
      setView({ kind: "chapter", chapter: await api.getChapter(chapterId) });
    }
    showToast("已替换原文并更新摘要");
  };

  /** 调整章节所属卷：落库 + 刷新侧栏分组 + 就地更新当前编辑器 */
  const handleChangeChapterVolume = async (chapterId: number, itemId: number) => {
    try {
      await api.setChapterVolume(chapterId, itemId);
      if (currentProjectId != null) await refreshChapters(currentProjectId);
      if (view?.kind === "chapter" && view.chapter.id === chapterId) {
        setView({
          kind: "chapter",
          chapter: { ...view.chapter, outline_item_id: itemId },
        });
      }
    } catch (e) {
      showToast(`调整分卷失败：${String(e)}`);
    }
  };

  const currentProject = projects.find((p) => p.id === currentProjectId);

  // ---------- 导出 ----------

  const handleExport = async () => {
    if (currentProjectId == null) return;
    const project = projects.find((p) => p.id === currentProjectId);
    const path = await save({
      defaultPath: `${project?.name ?? "作品"}.txt`,
      filters: [{ name: "文本文件", extensions: ["txt"] }],
    });
    if (!path) return; // 用户取消
    try {
      const written = await api.exportProject(currentProjectId, path);
      showToast(`已导出：${written}`);
    } catch (e) {
      showToast(`导出失败：${String(e)}`);
    }
  };

  return (
    <div className="flex h-screen flex-col bg-canvas text-body">
      <Caption />

      <div className="flex min-h-0 flex-1">
        <AppRail
          onShelf={!settingsOpen && !stylesOpen && !tasksOpen && currentProjectId == null}
          hasProject={
            currentProjectId != null ||
            (lastProjectId != null && projects.some((p) => p.id === lastProjectId))
          }
          settingsActive={settingsOpen}
          stylesActive={stylesOpen}
          tasksActive={tasksOpen}
          tasksRunning={tasksRunning}
          activeView={
            settingsOpen || stylesOpen || tasksOpen
              ? null
              : view?.kind === "check"
                  ? "check"
                  : view?.kind === "video"
                    ? "video"
                    : view?.kind === "publish"
                      ? "publish"
                      : null
          }
          onGoShelf={() => {
            setSettingsOpen(false);
            setStylesOpen(false);
            setTasksOpen(false);
            setCurrentProjectId(null);
          }}
          onGoCheck={() => goWorkshop({ kind: "check" })}
          onGoVideo={() => goWorkshop({ kind: "video" })}
          onGoPublish={() => goWorkshop({ kind: "publish" })}
          onGoStyles={() => {
            setSettingsOpen(false);
            setTasksOpen(false);
            setStylesOpen(true);
          }}
          onGoTasks={() => {
            setSettingsOpen(false);
            setStylesOpen(false);
            setTasksOpen(true);
          }}
          onExport={() => void handleExport()}
          onOpenSettings={() => {
            setStylesOpen(false);
            setTasksOpen(false);
            setSettingsOpen(true);
          }}
        />

        {settingsOpen ? (
          <SettingsView />
        ) : tasksOpen ? (
          <TasksView
            tasks={tasks}
            projects={projects}
            onChanged={() => {
              void pollTasks();
              // 回滚/重试后章节内容可能变了
              if (currentProjectId != null) void refreshChapters(currentProjectId);
            }}
            onToast={showToast}
          />
        ) : stylesOpen ? (
          <StylesView
            currentProjectId={currentProjectId}
            currentProjectStyleId={currentProject?.style_id ?? 0}
            onApplied={() => {
              void api.listProjects().then(setProjects);
              showToast("已更新当前作品的写作风格");
            }}
          />
        ) : currentProjectId == null ? (
          <Bookshelf
            projects={projects}
            onOpen={(id) => void handleOpenProject(id)}
            onDetail={(id) => setDetailId(id)}
            onCreate={(name, total, per, styleId) =>
              void handleCreateProject(name, total, per, styleId)
            }
            onOpenWizard={() => {
              setWizardEverOpened(true);
              setWizardOpen(true);
            }}
            onRename={(id, name) => void handleRenameProject(id, name)}
            onDelete={(id) => void handleDeleteProject(id)}
          />
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* 封面/体检/视频是整页工坊，不带写作侧栏 */}
            {(view == null ||
              view.kind === "chapter" ||
              view.kind === "lore" ||
              view.kind === "loreLedger" ||
              view.kind === "outline") && (
              <Sidebar
                chapters={chapters}
                loreEntries={loreEntries}
                outlineItems={outlineItems}
                currentChapterId={currentChapterId}
                currentLoreId={currentLoreId}
                outlineActive={view?.kind === "outline"}
                onSelectChapter={(id) => void handleSelectChapter(id)}
                onCreateChapter={() => void handleCreateChapter()}
                onDeleteChapter={(id) => void handleDeleteChapter(id)}
                onSelectLore={handleSelectLore}
                onCreateLore={() => void handleCreateLore()}
                onDeleteLore={(id) => void handleDeleteLore(id)}
                onSelectLoreLedger={() => setView({ kind: "loreLedger" })}
                loreLedgerActive={view?.kind === "loreLedger"}
                onSelectOutline={() => setView({ kind: "outline" })}
                onSelectCover={() => setView({ kind: "cover" })}
              />
            )}

            <main className="flex min-w-0 flex-1 flex-col">
              {view?.kind === "chapter" ? (
                <Editor
                  key={`${view.chapter.id}-${view.chapter.updated_at}`}
                  chapter={view.chapter}
                  onSaved={handleChapterSaved}
                  onOpenBatchWrite={() => setBatchOpen(true)}
                  initialScroll={view.initialScroll}
                  outlineItems={outlineItems}
                  onChangeVolume={(itemId) =>
                    void handleChangeChapterVolume(view.chapter.id, itemId)
                  }
                  onScrollPos={(top) => {
                    if (view.kind === "chapter") handleScrollPos(view.chapter.id, top);
                  }}
                />
              ) : view?.kind === "lore" ? (
                <LoreEditor
                  key={view.entry.id}
                  entry={view.entry}
                  onSaved={handleLoreSaved}
                />
              ) : view?.kind === "loreLedger" ? (
                <LoreLedgerView
                  key={currentProjectId}
                  projectId={currentProjectId}
                  chapters={chapters}
                  currentChapterId={currentChapterId}
                />
              ) : view?.kind === "cover" ? (
                <CoverView
                  key={currentProjectId}
                  projectId={currentProjectId}
                  projectName={currentProject?.name ?? ""}
                />
              ) : view?.kind === "check" ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  <WorkshopBar
                    projects={projects}
                    currentId={currentProjectId}
                    onSwitch={switchWorkshopProject}
                  />
                  <CheckView key={currentProjectId} projectId={currentProjectId} />
                </div>
              ) : view?.kind === "outline" && currentProject != null ? (
                <OutlineView
                  key={currentProjectId}
                  project={currentProject}
                  onProjectChanged={() => {
                    void api.listProjects().then(setProjects);
                    void refreshOutline(currentProjectId);
                  }}
                />
              ) : view?.kind === "video" ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  <WorkshopBar
                    projects={projects}
                    currentId={currentProjectId}
                    onSwitch={switchWorkshopProject}
                  />
                  <VideoView
                    key={currentProjectId}
                    projectId={currentProjectId}
                    chapters={chapters}
                  />
                </div>
              ) : view?.kind === "publish" ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  <WorkshopBar
                    projects={projects}
                    currentId={currentProjectId}
                    onSwitch={switchWorkshopProject}
                  />
                  <PublishView
                    key={currentProjectId}
                    projectId={currentProjectId}
                    chapters={chapters}
                  />
                </div>
              ) : chapters.length === 0 ? (
                <div className="flex flex-1 items-center justify-center">
                  <div className="text-center">
                    <p className="font-display text-2xl font-bold tracking-tight text-ink">
                      还没有章节，从第一章开始
                    </p>
                    <p className="mt-3 text-[13px] text-muted">
                      让 AI 按作品简介和设定直接开写，或先手动建一章
                    </p>
                    <div className="mt-5 flex items-center justify-center gap-2.5">
                      <button
                        className="rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-surface shadow-glow transition-colors hover:bg-accent-h"
                        onClick={() => setBatchOpen(true)}
                      >
                        AI 批量写章
                      </button>
                      <button
                        className="rounded-full bg-card/70 px-4 py-2 text-[13px] text-body shadow-card transition-colors hover:bg-surface"
                        onClick={() => void handleCreateChapter()}
                      >
                        手动创建第一章
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-1 items-center justify-center">
                  <div className="text-center">
                    <p className="font-display text-2xl font-bold tracking-tight text-ink">
                      选择一个章节，或到「设定库」建人物卡
                    </p>
                    <p className="mt-3 text-[13px] text-muted">
                      设定库词条会在 AI 续写时按关键词自动注入，人设不再崩
                    </p>
                  </div>
                </div>
              )}
            </main>
          </div>
        )}
      </div>

      {batchOpen && currentProject && (
        <BatchWriteDialog
          project={currentProject}
          chapters={chapters}
          batch={activeBatch}
          onStart={(o) => void handleBatchStart(currentProject, o)}
          onMinimize={handleBatchMinimize}
          onCancel={handleBatchCancel}
          onClose={handleBatchClose}
        />
      )}

      {/* 有任务在跑时的悬浮进度条（点击：批量写章→弹层；其他→任务面板） */}
      {runningTask && !batchOpen && !tasksOpen && (
        <button
          className="fixed bottom-24 right-6 z-40 w-64 rounded-2xl bg-surface p-3.5 text-left shadow-float transition-transform hover:-translate-y-0.5"
          onClick={() => {
            if (runningTask.kind === "batch_chapters") {
              if (runningTask.project_id !== currentProjectId) {
                setCurrentProjectId(runningTask.project_id);
              }
              setBatchOpen(true);
            } else {
              setSettingsOpen(false);
              setStylesOpen(false);
              setTasksOpen(true);
            }
          }}
        >
          <div className="flex justify-between text-xs text-muted">
            <span className="truncate">
              {runningTask.label}｜{runningTask.progress_label}
            </span>
            <span>
              {runningTask.progress_current}/{runningTask.progress_total}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-track">
            <div
              className="h-full rounded-full bg-accent transition-all"
              style={{
                width: `${
                  runningTask.progress_total === 0
                    ? 5
                    : (runningTask.progress_current / runningTask.progress_total) * 100
                }%`,
              }}
            />
          </div>
        </button>
      )}

      {/* AI 助手：写作态悬浮球 + 右侧抽屉（常驻挂载不丢对话） */}
      {assistantVisible && !assistantOpen && (
        <button
          className="fixed bottom-6 right-6 z-40 flex h-11 w-11 items-center justify-center rounded-full bg-accent text-surface shadow-glow transition-transform hover:-translate-y-0.5"
          title="AI 助手（聊剧情/改写本章）"
          onClick={() => {
            setAssistantEverOpened(true);
            setAssistantOpen(true);
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
            <path d="M21 11.5a8.38 8.38 0 0 1-9 8.4 8.5 8.5 0 0 1-3.4-.7L3 21l1.8-5.4a8.38 8.38 0 0 1-.9-4.1 8.5 8.5 0 0 1 8.5-8.5 8.38 8.38 0 0 1 8.6 8.5z" />
          </svg>
        </button>
      )}
      {assistantEverOpened && (
        <div className={assistantOpen && assistantVisible ? "" : "hidden"}>
          <AssistantPanel
            key={currentProjectId ?? 0}
            projectId={currentProjectId ?? 0}
            chapterId={view?.kind === "chapter" ? view.chapter.id : null}
            chapterTitle={view?.kind === "chapter" ? view.chapter.title : null}
            onChapterReplaced={(id) => void handleChapterReplaced(id)}
            onClose={() => setAssistantOpen(false)}
          />
        </div>
      )}

      {/* 书籍详情：整页覆盖层（书架 ⋯ 菜单「作品详情」） */}
      {detailId != null &&
        (() => {
          const p = projects.find((x) => x.id === detailId);
          if (!p) return null;
          return (
            <div className="fixed inset-x-0 bottom-0 top-11 z-40">
              <BookDetailView
                project={p}
                onClose={() => setDetailId(null)}
                onOpenWrite={(id) => {
                  setDetailId(null);
                  void handleOpenProject(id);
                }}
              />
            </div>
          );
        })()}

      {/* 工坊选书面板：无最近书籍上下文时，点导航先挑书 */}
      {workshopPicker != null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => setWorkshopPicker(null)}
        >
          <div
            className="mx-4 w-full max-w-sm rounded-2xl bg-surface p-5 shadow-float"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center">
              <p className="text-[14px] font-semibold text-ink">选择作品</p>
              <button
                className="ml-auto text-faint hover:text-body"
                onClick={() => setWorkshopPicker(null)}
              >
                ×
              </button>
            </div>
            <div className="mt-3 max-h-72 overflow-y-auto">
              {projects.length === 0 && (
                <p className="py-6 text-center text-[13px] text-faint">
                  还没有作品，先到书架创建一本
                </p>
              )}
              {projects.map((p) => (
                <button
                  key={p.id}
                  className="block w-full rounded-[10px] px-3 py-2.5 text-left transition-colors hover:bg-hover"
                  onClick={() => {
                    pendingViewRef.current = workshopPicker;
                    setWorkshopPicker(null);
                    setCurrentProjectId(p.id);
                  }}
                >
                  <span className="block truncate text-[13px] font-medium text-ink">
                    {p.name}
                  </span>
                  <span className="text-[11px] text-faint">
                    {p.description || "原创小说"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-[#26262a]/90 px-4 py-2 text-sm text-surface shadow-float backdrop-blur">
          {toast}
        </div>
      )}

      {/* AI 起书向导：整页覆盖层；收起只是隐藏（常驻挂载），对话与草稿不丢 */}
      {wizardEverOpened && (
        <div
          className={
            wizardOpen
              ? "fixed inset-x-0 bottom-0 top-11 z-40 flex flex-col bg-canvas"
              : "hidden"
          }
        >
          <AICreateWizard
            key={wizardEpoch}
            startFresh={wizardFresh}
            onFreshConsumed={() => setWizardFresh(false)}
            onCancel={() => setWizardOpen(false)}
            onCreate={(draft) => {
              setWizardOpen(false);
              setWizardFresh(true); // 这本书的会话留在历史归档，下一本从干净会话开始
              setWizardEpoch((e) => e + 1);
              void handleAiCreate(draft);
            }}
          />
        </div>
      )}
    </div>
  );
}

/** 整页工坊顶部的作品切换条：换书后停在当前工坊（pendingView 带过去） */
function WorkshopBar({
  projects,
  currentId,
  onSwitch,
}: {
  projects: Project[];
  currentId: number | null;
  onSwitch: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = projects.find((p) => p.id === currentId);
  return (
    <div className="relative flex items-center px-4 pt-3">
      <button
        className="flex items-center gap-2 rounded-full bg-card/70 py-1.5 pl-3 pr-2.5 shadow-card transition-colors hover:bg-surface"
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 text-muted">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
        <span className="max-w-48 truncate text-xs font-medium text-ink">
          {current?.name ?? "选择作品"}
        </span>
        <svg viewBox="0 0 12 12" className={`h-3 w-3 text-faint transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-4 top-full z-40 mt-1 max-h-72 w-56 overflow-y-auto rounded-xl bg-surface py-1 shadow-float">
            {projects.map((p) => (
              <button
                key={p.id}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-hover ${
                  p.id === currentId ? "bg-accent-soft/60" : ""
                }`}
                onClick={() => {
                  setOpen(false);
                  onSwitch(p.id);
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ink">
                    {p.name}
                  </span>
                  <span className="block truncate text-[11px] text-faint">
                    {p.description || "原创小说"}
                  </span>
                </span>
                {p.id === currentId && (
                  <span className="shrink-0 text-accent">✓</span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
