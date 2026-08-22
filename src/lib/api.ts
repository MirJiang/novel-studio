import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Chapter, ChapterMeta, ChatMsg, ChatSession, CheckFixPlan, CheckReportMeta, DialogueStats, FqBook, FqDistillResult, LoreChange, LoreEntry, LoreRelation, OutlineItem, Project, ScanResult, ScopeItem, Style, Task, Video, VideoDetail } from "../types";

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

/** 本地书籍导入结果 */
export interface ImportBookResult {
  project: Project;
  chapters: number;
  words: number;
  format: string;
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

  saveOutlineItem: (
    id: number,
    title: string,
    content: string,
    targetChapters?: number
  ) =>
    invoke<void>("save_outline_item", { id, title, content, targetChapters }),

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

  /** 选择音频文件（BGM），取消返回 null */
  pickAudio: () =>
    open({
      multiple: false,
      filters: [{ name: "音频", extensions: ["mp3", "wav", "m4a", "aac", "ogg"] }],
    }),

  /** 选择 txt 保存路径，取消返回 null */
  saveTextPath: (defaultName: string) =>
    save({
      defaultPath: defaultName,
      filters: [{ name: "文本文件", extensions: ["txt"] }],
    }),

  /** 选择本地书籍文件（导入用），取消返回 null */
  pickBookFile: async () => {
    const r = await open({
      multiple: false,
      filters: [
        { name: "书籍文件", extensions: ["txt", "md", "markdown", "epub", "docx"] },
      ],
    });
    return typeof r === "string" ? r : null;
  },

  /** 导入本地书籍：解析 + 建作品 + 章节批量入库，返回作品与统计 */
  importLocalBook: (path: string) =>
    invoke<ImportBookResult>("import_local_book", { path }),

  // ---------- 番茄在线搜书（仅供个人学习与风格分析） ----------

  /** 在线搜索番茄小说（公开中继 API） */
  fqSearch: (query: string) => invoke<FqBook[]>("fq_search", { query }),

  /** 在线蒸馏：抓样本 → 后端直接蒸馏入库（maxChars 空=全本，抓取进度走事件） */
  fqDistill: (
    bookId: string,
    maxChars: number | null,
    onEvent: (event: ProgressEvent) => void
  ) => {
    const channel = new Channel<ProgressEvent>();
    channel.onmessage = onEvent;
    return invoke<FqDistillResult>("fq_distill", { bookId, maxChars, channel });
  },

  /** 下载全本为 txt（进度事件；失败章节留占位行不中断），返回结果说明 */
  fqDownload: (
    bookId: string,
    path: string,
    onEvent: (event: ProgressEvent) => void
  ) => {
    const channel = new Channel<ProgressEvent>();
    channel.onmessage = onEvent;
    return invoke<string>("fq_download", { bookId, path, channel });
  },

  /** 选择片头/片尾素材（视频或图片），取消返回 null */
  pickMedia: () =>
    open({
      multiple: false,
      filters: [
        { name: "视频或图片", extensions: ["mp4", "mov", "png", "jpg", "jpeg", "webp"] },
      ],
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

  /** AI 从全书摘要链搜集人物/地点/物品等设定词条入库，返回结果说明 */
  collectLoreEntries: (projectId: number) =>
    invoke<string>("collect_lore_entries", { projectId }),

  /** 穷尽式设定收集：逐章扫正文收集所有具体元素（含次要物品），进度事件 */
  collectLoreExhaustive: (
    projectId: number,
    onEvent: (event: ProgressEvent) => void
  ) => {
    const channel = new Channel<ProgressEvent>();
    channel.onmessage = onEvent;
    return invoke<string>("collect_lore_exhaustive", { projectId, channel });
  },

  /** 评分报告 → AI 整改方案（含受影响章节与改写指令），前端展示后一键入队 */
  makeCheckFixPlan: (projectId: number, reportId: number) =>
    invoke<CheckFixPlan>("make_check_fix_plan", { projectId, reportId }),

  /** 人物卡视觉参考图，返回存储路径 */
  setLoreRefImage: (entryId: number, srcPath: string) =>
    invoke<string>("set_lore_ref_image", { entryId, srcPath }),

  removeLoreRefImage: (entryId: number) =>
    invoke<void>("remove_lore_ref_image", { entryId }),

  /** AI 生成设定图（人物=正/侧/背三视图），存为参考图，返回存储路径；style 为可选画风锚点词 */
  generateLoreRefImage: (entryId: number, style?: string) =>
    invoke<string>("generate_lore_ref_image", { entryId, style: style ?? null }),

  /** 生成封面：AI 底图 + 程序排版书名，返回路径和预览；style 为可选画风锚点词 */
  generateCover: (
    projectId: number,
    prompt: string,
    title: string,
    author: string,
    style?: string
  ) =>
    invoke<CoverResult>("generate_cover", {
      projectId,
      prompt,
      title,
      author,
      style: style ?? null,
    }),

  /** 封面历史（文件路径，新→旧） */
  listCovers: (projectId: number) =>
    invoke<string[]>("list_covers", { projectId }),

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

  /** 继续被断点暂停的任务 */
  resumeTask: (id: number) => invoke<void>("resume_task", { id }),

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

  /** 手动调整章节所属卷（0 = 未分卷） */
  setChapterVolume: (chapterId: number, outlineItemId: number) =>
    invoke<void>("set_chapter_volume", { chapterId, outlineItemId }),

  /** 生成章节摘要（后端存库并返回摘要文本） */
  generateSummary: (chapterId: number) =>
    invoke<string>("generate_summary", { chapterId }),

  // ---------- 设定变更台账 ----------

  /** 手动提取某章的设定变更/实体/关系（重复提取幂等），返回统计说明 */
  extractLoreChanges: (chapterId: number) =>
    invoke<string>("extract_lore_changes", { chapterId }),

  /** 台账列表（entryId/entryTitle 给值时按条目过滤，条目时间线用） */
  listLoreChanges: (
    projectId: number,
    entryId?: number,
    entryTitle?: string
  ) =>
    invoke<LoreChange[]>("list_lore_changes", {
      projectId,
      entryId,
      entryTitle,
    }),

  /** 应用台账变更到设定库（活设定：LLM 重写词条为当前状态，重写前快照），返回结果说明 */
  applyLoreChanges: (projectId: number) =>
    invoke<string>("apply_lore_changes", { projectId }),

  /** 回滚最近一次应用：恢复词条快照 + 变更回到待应用 */
  rollbackLoreApply: (projectId: number) =>
    invoke<string>("rollback_lore_apply", { projectId }),

  /** 关系三元组列表（人物资产/反向查询用） */
  listLoreRelations: (projectId: number) =>
    invoke<LoreRelation[]>("list_lore_relations", { projectId }),

  /** 分章对话占比（本地统计，无 LLM 调用） */
  dialogueStats: (projectId: number) =>
    invoke<DialogueStats>("dialogue_stats", { projectId }),

  /** 压缩远期摘要（分层记忆：每 50 章一段梗概，进度事件），返回结果说明 */
  compressEraSummaries: (
    projectId: number,
    onEvent: (event: ProgressEvent) => void
  ) => {
    const channel = new Channel<ProgressEvent>();
    channel.onmessage = onEvent;
    return invoke<string>("compress_era_summaries", { projectId, channel });
  },

  /** 导出整部作品为 txt，返回写入路径 */
  exportProject: (projectId: number, path: string) =>
    invoke<string>("export_project", { projectId, path }),

  /** 划词处理：mode = rewrite | polish | expand | deslop（去AI味） */
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
    mode?: "image" | "video",
    style?: string,
    motionStyle?: string
  ) =>
    invoke<Video>("create_video", {
      projectId,
      title,
      chapterIds,
      mode: mode ?? null,
      style: style ?? null,
      motionStyle: motionStyle ?? null,
    }),

  listVideos: (projectId: number) =>
    invoke<Video[]>("list_videos", { projectId }),

  getVideoDetail: (videoId: number) =>
    invoke<VideoDetail>("get_video_detail", { videoId }),

  deleteVideo: (videoId: number) => invoke<void>("delete_video", { videoId }),

  saveNarration: (videoId: number, narration: string) =>
    invoke<void>("save_narration", { videoId, narration }),

  /** 全片统一画风 + 运镜风格（生成期注入每个镜头的生图/运动 prompt） */
  setVideoStyle: (videoId: number, style: string, motionStyle: string) =>
    invoke<void>("set_video_style", { videoId, style, motionStyle }),

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

  /** 设置 BGM/片头片尾（空串 = 清除；文件会被拷入视频目录） */
  setVideoExtras: (
    videoId: number,
    bgmPath: string,
    bgmVolume: number,
    introPath: string,
    outroPath: string
  ) =>
    invoke<void>("set_video_extras", {
      videoId,
      bgmPath,
      bgmVolume,
      introPath,
      outroPath,
    }),

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

  /** 选择 txt 样本文件（蒸馏用，后端直读不进前端），取消返回 null */
  pickBookText: async () => {
    const r = await open({
      multiple: false,
      filters: [{ name: "文本文件", extensions: ["txt"] }],
    });
    return typeof r === "string" ? r : null;
  },

  /** 上传 txt 蒸馏：后端读文件（UTF-8/GBK 自适应）→ 头中尾三段取样蒸馏入库 */
  distillStyleFromFile: (name: string, path: string) =>
    invoke<Style>("distill_style_from_file", { name, path }),

  listStyles: () => invoke<Style[]>("list_styles"),

  deleteStyle: (id: number) => invoke<void>("delete_style", { id }),

  /** 保存对话生成的风格卡 */
  saveStyleCard: (name: string, source: string, guide: string, kind?: string) =>
    invoke<Style>("save_style_card", { name, source, guide, kind }),

  /** 对话式风格定制（流式）：多轮问答，AI 出卡时回复带 [CARD] 标记，由前端解析；
   *  baseCard 有值时为「优化现有风格」模式（现有卡垫作上下文） */
  generateStyleCardStream: (
    messages: ChatMsg[],
    kind: "text" | "image" | "video",
    baseCard: string | undefined,
    onEvent: (event: StreamEvent) => void
  ) => {
    const channel = new Channel<StreamEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("generate_style_card_stream", {
      messages,
      kind,
      baseCard,
      channel,
    });
  },

  /** 更新现有风格卡（对话优化后保存修改） */
  updateStyle: (id: number, name: string, guide: string) =>
    invoke<void>("update_style", { id, name, guide }),

  // ---------- 发布（番茄作家后台，fill-only） ----------

  /** 打开/聚焦番茄作家后台窗口（首次需扫码登录） */
  openFanqieWindow: () => invoke<void>("open_fanqie_window"),

  /** 把章节填进后台当前编辑页（只填不发布），返回结果说明 */
  fillChapterDraft: (chapterId: number) =>
    invoke<string>("fill_chapter_draft", { chapterId }),

  /** 打开/聚焦抖音创作者中心上传页（首次需扫码登录） */
  openDouyinWindow: () => invoke<void>("open_douyin_window"),

  /** 把视频文案（标题+话题）填进抖音上传页（视频文件人工拖入） */
  fillDouyinCaption: (videoId: number) =>
    invoke<string>("fill_douyin_caption", { videoId }),

  /** 对话式起书（流式）：delta 实时推送；[DRAFT] 草稿由前端在 done 后解析 */
  aiBootstrapChatStream: (
    messages: ChatMsg[],
    onEvent: (event: StreamEvent) => void
  ) => {
    const channel = new Channel<StreamEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("ai_bootstrap_chat_stream", { messages, channel });
  },

  // ---------- 写作助手（悬浮窗） ----------

  /** 助手对话（全书上下文注入，流式） */
  assistantChat: (
    projectId: number,
    chapterId: number | null,
    messages: ChatMsg[],
    onEvent: (event: StreamEvent) => void
  ) => {
    const channel = new Channel<StreamEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("assistant_chat", { projectId, chapterId, messages, channel });
  },

  /** 单章改写（流式出预览全文，确认后才落库） */
  assistantRewriteChapter: (
    chapterId: number,
    instruction: string,
    onEvent: (event: StreamEvent) => void
  ) => {
    const channel = new Channel<StreamEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("assistant_rewrite_chapter", {
      chapterId,
      instruction,
      channel,
    });
  },

  /** 跨章改写：LLM 按摘要链定位受影响章节 */
  locateRewriteScope: (projectId: number, instruction: string) =>
    invoke<ScopeItem[]>("locate_rewrite_scope", { projectId, instruction }),

  /** 跨章改写入队（逐章快照，可回滚） */
  enqueueRewriteChapters: (
    projectId: number,
    chapterIds: number[],
    instruction: string
  ) =>
    invoke<Task>("enqueue_rewrite_chapters", { projectId, chapterIds, instruction }),

  /** 回滚跨章改写（恢复快照），返回结果说明 */
  rollbackRewriteTask: (taskId: number) =>
    invoke<string>("rollback_rewrite_task", { taskId }),

  /** 敏感词合规扫描（纯文本检索） */
  scanBannedWords: (projectId: number, words: string[]) =>
    invoke<ScanResult>("scan_banned_words", { projectId, words }),
  // ---------- 会话归档（起书向导 bootstrap / 风格对话 style 共用） ----------

  /** 保存会话（id=null 新建），返回会话 id；scene 默认 bootstrap */
  saveChatSession: (
    id: number | null,
    title: string,
    messages: string,
    draft: string,
    scene?: "bootstrap" | "style"
  ) => invoke<number>("save_chat_session", { id, title, messages, draft, scene }),

  /** 最近一条会话（按场景过滤，进入向导/风格对话恢复用） */
  getLatestChatSession: (scene?: "bootstrap" | "style") =>
    invoke<ChatSession | null>("get_latest_chat_session", { scene }),

  listChatSessions: (scene?: "bootstrap" | "style") =>
    invoke<ChatSession[]>("list_chat_sessions", { scene }),

  deleteChatSession: (id: number) =>
    invoke<void>("delete_chat_session", { id }),

  /** 本地文件 → 预览 URL（asset 协议，视频用；图片/视频帧都走 asset 协议） */
  fileUrl: (path: string) => convertFileSrc(path),
};
