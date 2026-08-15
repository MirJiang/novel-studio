import { useCallback, useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "./lib/api";
import type { BootstrapDraft, Chapter, ChapterMeta, LoreEntry, OutlineItem, Project, Task } from "./types";
import { Caption } from "./components/Caption";
import { AppRail } from "./components/AppRail";
import { Sidebar } from "./components/Sidebar";
import { Editor } from "./components/Editor";
import { LoreEditor } from "./components/LoreEditor";
import { CoverView } from "./components/CoverView";
import { CheckView } from "./components/CheckView";
import { VideoView } from "./components/VideoView";
import { PublishView } from "./components/PublishView";
import { TasksView } from "./components/TasksView";
import { OutlineView } from "./components/OutlineView";
import { SettingsView } from "./components/SettingsView";
import { StylesView } from "./components/StylesView";
import { Bookshelf } from "./components/Bookshelf";
import {
  BatchWriteDialog,
  type BatchStartOptions,
} from "./components/BatchWriteDialog";

/** 主视图：写章节 / 编辑设定 / 封面工坊 / 全书体检 */
type View =
  | { kind: "chapter"; chapter: Chapter }
  | { kind: "lore"; entry: LoreEntry }
  | { kind: "outline" }
  | { kind: "cover" }
  | { kind: "check" }
  | { kind: "video" }
  | { kind: "publish" }
  | null;

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<number | null>(null);
  const [chapters, setChapters] = useState<ChapterMeta[]>([]);
  const [loreEntries, setLoreEntries] = useState<LoreEntry[]>([]);
  const [outlineItems, setOutlineItems] = useState<OutlineItem[]>([]);
  const [view, setView] = useState<View>(null);
  const [settingsOpen, setSettingsOpen] = useState(false); // 设置页（整页路由，非弹窗）
  const [stylesOpen, setStylesOpen] = useState(false); // 风格库（整页路由，全局）
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    api.listProjects().then(setProjects).catch(console.error);
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
    void refreshChapters(currentProjectId);
    void refreshLore(currentProjectId);
    void refreshOutline(currentProjectId);
    setView(null);
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
      setProjects((prev) => [p, ...prev]);
      setCurrentProjectId(p.id);
      showToast(`《${p.name}》已创建，含 ${draft.lore.length} 条初始设定`);
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

  const handleSelectChapter = async (id: number) => {
    try {
      setView({ kind: "chapter", chapter: await api.getChapter(id) });
    } catch (e) {
      console.error(e);
    }
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

  // 记住最近打开的章节，供导航栏「写作」恢复视图
  const lastChapterRef = useRef<Chapter | null>(null);
  useEffect(() => {
    if (view?.kind === "chapter") lastChapterRef.current = view.chapter;
  }, [view]);

  const handleGoWrite = () => {
    if (view?.kind === "chapter" || view?.kind === "lore") return;
    const last = lastChapterRef.current;
    if (last && chapters.some((c) => c.id === last.id)) {
      void handleSelectChapter(last.id);
    } else if (chapters.length > 0) {
      void handleSelectChapter(chapters[0].id);
    }
  };

  /** 从书架进入作品：自动切到写作态——打开最近章节，没有记忆则打开最新一章 */
  const handleOpenProject = async (id: number) => {
    setCurrentProjectId(id);
    const list = await api.listChapters(id);
    if (list.length === 0) return; // 零章节新书停在空状态页（有批量写章入口）
    const last = lastChapterRef.current;
    const target =
      last && list.some((c) => c.id === last.id)
        ? last.id
        : list[list.length - 1].id;
    void handleSelectChapter(target);
  };

  // 标题栏面包屑：作品名 / 当前视图
  const currentProject = projects.find((p) => p.id === currentProjectId);
  const viewLabel =
    view?.kind === "chapter"
      ? view.chapter.title
      : view?.kind === "lore"
        ? view.entry.title
            : view?.kind === "cover"
              ? "封面工坊"
              : view?.kind === "outline"
                ? "作品大纲"
                : view?.kind === "check"
                ? "全书体检"
                : view?.kind === "video"
                  ? "视频工坊"
                  : view?.kind === "publish"
                    ? "发布"
                    : null;
  const crumb = settingsOpen
    ? "设置"
    : tasksOpen
      ? "任务"
      : stylesOpen
        ? "风格库"
        : currentProject == null
          ? undefined
          : viewLabel
            ? `${currentProject.name}  /  ${viewLabel}`
            : currentProject.name;

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
      <Caption crumb={crumb} />

      <div className="flex min-h-0 flex-1">
        <AppRail
          onShelf={!settingsOpen && !stylesOpen && !tasksOpen && currentProjectId == null}
          hasProject={currentProjectId != null}
          settingsActive={settingsOpen}
          stylesActive={stylesOpen}
          tasksActive={tasksOpen}
          tasksRunning={tasksRunning}
          activeView={
            settingsOpen || stylesOpen || tasksOpen
              ? null
              : view?.kind === "cover"
                ? "cover"
                : view?.kind === "check"
                  ? "check"
                  : view?.kind === "video"
                    ? "video"
                    : view?.kind === "publish"
                      ? "publish"
                      : view?.kind === "chapter" || view?.kind === "lore"
                        ? "write"
                        : null
          }
          onGoShelf={() => {
            setSettingsOpen(false);
            setStylesOpen(false);
            setTasksOpen(false);
            setCurrentProjectId(null);
          }}
          onGoWrite={() => {
            setSettingsOpen(false);
            setStylesOpen(false);
            setTasksOpen(false);
            handleGoWrite();
          }}
          onGoCover={() => {
            setSettingsOpen(false);
            setStylesOpen(false);
            setTasksOpen(false);
            setView({ kind: "cover" });
          }}
          onGoCheck={() => {
            setSettingsOpen(false);
            setStylesOpen(false);
            setTasksOpen(false);
            setView({ kind: "check" });
          }}
          onGoVideo={() => {
            setSettingsOpen(false);
            setStylesOpen(false);
            setTasksOpen(false);
            setView({ kind: "video" });
          }}
          onGoPublish={() => {
            setSettingsOpen(false);
            setStylesOpen(false);
            setTasksOpen(false);
            setView({ kind: "publish" });
          }}
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
            onChanged={() => void pollTasks()}
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
            onCreate={(name, total, per, styleId) =>
              void handleCreateProject(name, total, per, styleId)
            }
            onAiCreate={(draft) => void handleAiCreate(draft)}
            onRename={(id, name) => void handleRenameProject(id, name)}
            onDelete={(id) => void handleDeleteProject(id)}
          />
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* 封面/体检/视频是整页工坊，不带写作侧栏 */}
            {(view == null ||
              view.kind === "chapter" ||
              view.kind === "lore" ||
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
                onSelectOutline={() => setView({ kind: "outline" })}
              />
            )}

            <main className="flex min-w-0 flex-1 flex-col">
              {view?.kind === "chapter" ? (
                <Editor
                  key={view.chapter.id}
                  chapter={view.chapter}
                  onSaved={handleChapterSaved}
                  onOpenBatchWrite={() => setBatchOpen(true)}
                />
              ) : view?.kind === "lore" ? (
                <LoreEditor
                  key={view.entry.id}
                  entry={view.entry}
                  onSaved={handleLoreSaved}
                />
              ) : view?.kind === "cover" ? (
                <CoverView
                  key={currentProjectId}
                  projectId={currentProjectId}
                  projectName={currentProject?.name ?? ""}
                />
              ) : view?.kind === "check" ? (
                <CheckView key={currentProjectId} projectId={currentProjectId} />
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
                <VideoView
                  key={currentProjectId}
                  projectId={currentProjectId}
                  chapters={chapters}
                />
              ) : view?.kind === "publish" ? (
                <PublishView
                  key={currentProjectId}
                  projectId={currentProjectId}
                  chapters={chapters}
                />
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
                        className="rounded-full bg-white/70 px-4 py-2 text-[13px] text-body shadow-card transition-colors hover:bg-surface"
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
          className="fixed bottom-6 right-6 z-40 w-64 rounded-2xl bg-surface p-3.5 text-left shadow-float transition-transform hover:-translate-y-0.5"
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
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/8">
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

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink/90 px-4 py-2 text-sm text-surface shadow-float backdrop-blur">
          {toast}
        </div>
      )}
    </div>
  );
}
