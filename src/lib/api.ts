import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import type { BootstrapDraft, Chapter, ChapterMeta, CheckReportMeta, LoreEntry, OutlineItem, Project, Style, Task, Video, VideoDetail } from "../types";

/** 无边框窗口的自制标题栏控制 */
const appWindow = getCurrentWindow();

/** 与 Rust 侧 StreamEvent 对应 */
export type StreamEvent =
  | { type: "meta"; note: string }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** 批量任务进度事件 */
export type ProgressEvent =
  | { type: "progress"; current: number; total: number; label: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface CoverResult {
  path: string;
  data_url: string;
  /** 实际使用的画面描述（留空自动总结时回传） */
  prompt: string;
}

/**
 * 全部后端调用的统一封装。
 * 注意：未来如果出网页版，只需把这里换成 fetch 实现，业务组件不用动。
 */
export const api = {
  // ---------- 窗口控制（无边框窗口的标题栏按钮） ----------
  winMinimize: () => appWindow.minimize().catch(console.error),
  winToggleMaximize: () => appWindow.toggleMaximize().catch(console.error),
  winClose: () => appWindow.close().catch(console.error),

  createProject: (
    name: string,
    description?: string,
    targetTotalWords?: number,
    targetChapterWords?: number,
    styleId?: number,
  ) =>
    invoke<Project>("create_project", {
      name,
      description: description ?? null,
      targetTotalWords: targetTotalWords ?? null,
      targetChapterWords: targetChapterWords ?? null,
      styleId: styleId ?? null,
    }),

  /** 给作品指定/清除写作风格（styleId = 0 清除） */
  setProjectStyle: (projectId: number, styleId: number) =>
    invoke<void>("set_project_style", { projectId, styleId }),

  /** 更新作品字数目标（全书总字数 / 每章字数） */
  updateProjectTargets: (
    id: number,
    targetTotalWords: number,
    targetChapterWords: number,
  ) =>
    invoke<void>("update_project_targets", {
      id,
      targetTotalWords,
      targetChapterWords,
    }),

  listProjects: () => invoke<Project[]>("list_projects"),

  renameProject: (id: number, name: string) =>
    invoke<void>("rename_project", { id, name }),

  deleteProject: (id: number) => invoke<void>("delete_project", { id }),

  /** 保存作品信息（题材标签 + 长简介） */
  saveProjectInfo: (id: number, description: string, synopsis: string) =>
    invoke<void>("save_project_info", { id, description, synopsis }),

  /** AI 生成番茄风简介（写库并返回） */
  generateSynopsis: (projectId: number) =>
    invoke<string>("generate_synopsis", { projectId }),

  // ---------- 大纲 ----------

  listOutline: (projectId: number) =>
    invoke<OutlineItem[]>("list_outline", { projectId }),

  addOutlineItem: (projectId: number, title: string) =>
    invoke<OutlineItem>("add_outline_item", { projectId, title }),

  saveOutlineItem: (id: number, title: string, content: string) =>
    invoke<void>("save_outline_item", { id, title, content }),

  setOutlineStatus: (id: number, status: string) =>
    invoke<void>("set_outline_status", { id, status }),

  deleteOutlineItem: (id: number) => invoke<void>("delete_outline_item", { id }),

  /** AI 生成分卷大纲（整表替换） */
  generateOutline: (projectId: number) =>
    invoke<OutlineItem[]>("generate_outline", { projectId }),

  /** 选择本地图片（人物卡参考图等），取消返回 null */
  pickImage: () =>
    open({
      multiple: false,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    }),

  createChapter: (projectId: number, title: string) =>
    invoke<Chapter>("create_chapter", { projectId, title }),

  listChapters: (projectId: number) =>
    invoke<ChapterMeta[]>("list_chapters", { projectId }),

  getChapter: (id: number) => invoke<Chapter>("get_chapter", { id }),

  saveChapter: (id: number, title: string, content: string) =>
    invoke<void>("save_chapter", { id, title, content }),

  deleteChapter: (id: number) => invoke<void>("delete_chapter", { id }),

  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),

  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),

  createLoreEntry: (projectId: number, title: string, category: string) =>
    invoke<LoreEntry>("create_lore_entry", { projectId, title, category }),

  listLoreEntries: (projectId: number) =>
    invoke<LoreEntry[]>("list_lore_entries", { projectId }),

  updateLoreEntry: (entry: LoreEntry) =>
    invoke<void>("update_lore_entry", { entry }),

  deleteLoreEntry: (id: number) => invoke<void>("delete_lore_entry", { id }),

  /** 人物卡视觉参考图，返回存储路径 */
  setLoreRefImage: (entryId: number, srcPath: string) =>
    invoke<string>("set_lore_ref_image", { entryId, srcPath }),

  removeLoreRefImage: (entryId: number) =>
    invoke<void>("remove_lore_ref_image", { entryId }),

  /** 生成封面：AI 底图 + 程序排版书名，返回路径和预览 */
  generateCover: (
    projectId: number,
    prompt: string,
    title: string,
    author: string
  ) =>
    invoke<CoverResult>("generate_cover", {
      projectId,
      prompt,
      title,
      author,
    }),

  /** 封面历史（文件路径，新→旧） */
  listCovers: (projectId: number) =>
    invoke<string[]>("list_covers", { projectId }),

  /** 读封面文件为 data URL */
  getCoverData: (path: string) => invoke<string>("get_cover_data", { path }),

  /** (总章节数, 已有摘要数) */
  summaryStats: (projectId: number) =>
    invoke<[number, number]>("summary_stats", { projectId }),

  /** 批量补齐缺失摘要（进度事件） */
  generateMissingSummaries: (
    projectId: number,
    onEvent: (event: ProgressEvent) => void
  ) => {
    const channel = new Channel<ProgressEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("generate_missing_summaries", { projectId, channel });
  },

  // ---------- 任务队列（长任务统一入队，前端轮询展示） ----------

  /**
   * 批量写章入队：从全书最后一章往后连续创作，逐章落库 + 自动摘要 + 收尾推进大纲。
   * chapterCount <= 0 表示「写完整本书」（按作品目标总字数推算章数）；
   * wordsPerChapter <= 0 时用作品设定的每章字数。
   */
  enqueueBatchChapters: (
    projectId: number,
    chapterCount: number,
    wordsPerChapter: number
  ) =>
    invoke<Task>("enqueue_batch_chapters", {
      projectId,
      chapterCount,
      wordsPerChapter,
    }),

  /** 镜头图生视频入队（跳过已有视频的镜头） */
  enqueueVideoShots: (videoId: number) =>
    invoke<Task>("enqueue_video_shots", { videoId }),

  listTasks: () => invoke<Task[]>("list_tasks"),

  /** 取消任务：pending 直接取消，running 在当前步骤完成后停 */
  cancelTask: (id: number) => invoke<void>("cancel_task", { id }),

  /** 失败/取消的任务按原参数重新入队 */
  retryTask: (id: number) => invoke<Task>("retry_task", { id }),

  clearFinishedTasks: () => invoke<void>("clear_finished_tasks"),

  /** 全书一致性体检（流式输出报告） */
  checkConsistency: (
    projectId: number,
    onEvent: (event: StreamEvent) => void
  ) => {
    const channel = new Channel<StreamEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("check_consistency", { projectId, channel });
  },

  saveCheckReport: (projectId: number, content: string) =>
    invoke<number>("save_check_report", { projectId, content }),

  listCheckReports: (projectId: number) =>
    invoke<CheckReportMeta[]>("list_check_reports", { projectId }),

  getCheckReport: (id: number) => invoke<string>("get_check_report", { id }),

  saveSummary: (id: number, summary: string) =>
    invoke<void>("save_summary", { id, summary }),

  /** 生成章节摘要（后端存库并返回摘要文本） */
  generateSummary: (chapterId: number) =>
    invoke<string>("generate_summary", { chapterId }),

  /** 导出整部作品为 txt，返回写入路径 */
  exportProject: (projectId: number, path: string) =>
    invoke<string>("export_project", { projectId, path }),

  /** 划词处理：mode = rewrite | polish | expand */
  aiTransform: (
    chapterId: number,
    mode: string,
    selectedText: string,
    onEvent: (event: StreamEvent) => void
  ) => {
    const channel = new Channel<StreamEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("ai_transform", {
      chapterId,
      mode,
      selectedText,
      channel,
    });
  },

  /** 流式续写：事件通过 Channel 回调推送 */
  aiContinue: (
    chapterId: number,
    instruction: string,
    onEvent: (event: StreamEvent) => void
  ) => {
    const channel = new Channel<StreamEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("ai_continue", { chapterId, instruction, channel });
  },

  // ---------- 推文视频 ----------

  createVideo: (
    projectId: number,
    title: string,
    chapterIds: number[],
    mode?: "image" | "video"
  ) =>
    invoke<Video>("create_video", {
      projectId,
      title,
      chapterIds,
      mode: mode ?? null,
    }),

  listVideos: (projectId: number) =>
    invoke<Video[]>("list_videos", { projectId }),

  getVideoDetail: (videoId: number) =>
    invoke<VideoDetail>("get_video_detail", { videoId }),

  deleteVideo: (videoId: number) => invoke<void>("delete_video", { videoId }),

  saveNarration: (videoId: number, narration: string) =>
    invoke<void>("save_narration", { videoId, narration }),

  updateShotPrompt: (shotId: number, prompt: string) =>
    invoke<void>("update_shot_prompt", { shotId, prompt }),

  /** 生成口播稿（流式） */
  generateNarration: (
    videoId: number,
    onEvent: (event: StreamEvent) => void
  ) => {
    const channel = new Channel<StreamEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("generate_narration", { videoId, channel });
  },

  generateStoryboard: (videoId: number) =>
    invoke<VideoDetail>("generate_storyboard", { videoId }),

  /** 单镜生图/重绘，返回图片路径 */
  generateShotImage: (shotId: number) =>
    invoke<string>("generate_shot_image", { shotId }),

  /** 单镜图生视频/重跑（约 1~2 分钟） */
  generateShotVideo: (shotId: number) =>
    invoke<void>("generate_shot_video", { shotId }),

  generateMissingImages: (
    videoId: number,
    onEvent: (event: ProgressEvent) => void
  ) => {
    const channel = new Channel<ProgressEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("generate_missing_images", { videoId, channel });
  },

  synthesizeVoices: (
    videoId: number,
    onEvent: (event: ProgressEvent) => void
  ) => {
    const channel = new Channel<ProgressEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("synthesize_voices", { videoId, channel });
  },

  composeVideo: (
    videoId: number,
    onEvent: (event: ProgressEvent) => void
  ) => {
    const channel = new Channel<ProgressEvent>();
    channel.onmessage = onEvent;
    return invoke<VideoDetail>("compose_video", { videoId, channel });
  },

  openVideoFolder: (videoId: number) =>
    invoke<void>("open_video_folder", { videoId }),

  // ---------- 写作风格 ----------

  /** 蒸馏风格：样本文本 → LLM 风格卡 → 入库 */
  distillStyle: (name: string, source: string, sampleText: string) =>
    invoke<Style>("distill_style", { name, source, sampleText }),

  listStyles: () => invoke<Style[]>("list_styles"),

  deleteStyle: (id: number) => invoke<void>("delete_style", { id }),

  // ---------- 发布（番茄作家后台，fill-only） ----------

  /** 打开/聚焦番茄作家后台窗口（首次需扫码登录） */
  openFanqieWindow: () => invoke<void>("open_fanqie_window"),

  /** 把章节填进后台当前编辑页（只填不发布），返回结果说明 */
  fillChapterDraft: (chapterId: number) =>
    invoke<string>("fill_chapter_draft", { chapterId }),

  /** AI 起书：一句话创意 → 书名/简介/初始设定草稿 */
  aiBootstrapDraft: (idea: string) =>
    invoke<BootstrapDraft>("ai_bootstrap_draft", { idea }),

  /** AI 润色创意：一句话创意 → 更具体的创作 brief */
  aiPolishIdea: (idea: string) => invoke<string>("ai_polish_idea", { idea }),

  /** 本地文件 → 预览 URL（asset 协议，视频用；图片用 getCoverData 的 data URL） */
  fileUrl: (path: string) => convertFileSrc(path),
};
