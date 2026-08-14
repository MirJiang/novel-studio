import { useCallback, useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "./lib/api";
import type { BootstrapDraft, Chapter, ChapterMeta, LoreEntry, OutlineItem, Project } from "./types";
import { Caption } from "./components/Caption";
import { AppRail } from "./components/AppRail";
import { Sidebar } from "./components/Sidebar";
import { Editor } from "./components/Editor";
import { LoreEditor } from "./components/LoreEditor";
import { CoverView } from "./components/CoverView";
import { CheckView } from "./components/CheckView";
import { VideoView } from "./components/VideoView";
import { OutlineView } from "./components/OutlineView";
import { SettingsView } from "./components/SettingsView";
import { Bookshelf } from "./components/Bookshelf";

/** 主视图：写章节 / 编辑设定 / 封面工坊 / 全书体检 */
type View =
  | { kind: "chapter"; chapter: Chapter }
  | { kind: "lore"; entry: LoreEntry }
  | { kind: "outline" }
  | { kind: "cover" }
  | { kind: "check" }
  | { kind: "video" }
  | null;

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<number | null>(null);
  const [chapters, setChapters] = useState<ChapterMeta[]>([]);
  const [loreEntries, setLoreEntries] = useState<LoreEntry[]>([]);
  const [outlineItems, setOutlineItems] = useState<OutlineItem[]>([]);
  const [view, setView] = useState<View>(null);
  const [settingsOpen, setSettingsOpen] = useState(false); // 设置页（整页路由，非弹窗）
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

  const handleCreateProject = async (name: string) => {
    const p = await api.createProject(name);
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
      const p = await api.createProject(draft.name, draft.description);
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
              : null;
  const crumb = settingsOpen
    ? "设置"
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
          onShelf={!settingsOpen && currentProjectId == null}
          hasProject={currentProjectId != null}
          settingsActive={settingsOpen}
          activeView={
            settingsOpen
              ? null
              : view?.kind === "cover"
                ? "cover"
                : view?.kind === "check"
                  ? "check"
                  : view?.kind === "video"
                    ? "video"
                    : view?.kind === "chapter" || view?.kind === "lore"
                      ? "write"
                      : null
          }
          onGoShelf={() => {
            setSettingsOpen(false);
            setCurrentProjectId(null);
          }}
          onGoWrite={() => {
            setSettingsOpen(false);
            handleGoWrite();
          }}
          onGoCover={() => {
            setSettingsOpen(false);
            setView({ kind: "cover" });
          }}
          onGoCheck={() => {
            setSettingsOpen(false);
            setView({ kind: "check" });
          }}
          onGoVideo={() => {
            setSettingsOpen(false);
            setView({ kind: "video" });
          }}
          onExport={() => void handleExport()}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        {settingsOpen ? (
          <SettingsView />
        ) : currentProjectId == null ? (
          <Bookshelf
            projects={projects}
            onOpen={setCurrentProjectId}
            onCreate={(name) => void handleCreateProject(name)}
            onAiCreate={(draft) => void handleAiCreate(draft)}
            onRename={(id, name) => void handleRenameProject(id, name)}
            onDelete={(id) => void handleDeleteProject(id)}
          />
        ) : (
          <div className="flex min-h-0 flex-1">
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

            <main className="flex min-w-0 flex-1 flex-col">
              {view?.kind === "chapter" ? (
                <Editor
                  key={view.chapter.id}
                  chapter={view.chapter}
                  onSaved={handleChapterSaved}
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

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink/90 px-4 py-2 text-sm text-surface shadow-float backdrop-blur">
          {toast}
        </div>
      )}
    </div>
  );
}
