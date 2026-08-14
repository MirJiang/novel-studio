export interface Project {
  id: number;
  name: string;
  /** 题材短标签（书架卡片用） */
  description: string;
  /** 番茄风长简介 */
  synopsis: string;
  created_at: number;
  updated_at: number;
}

export interface ChapterMeta {
  id: number;
  project_id: number;
  title: string;
  order_index: number;
  word_count: number;
  updated_at: number;
}

export interface Chapter extends ChapterMeta {
  content: string;
  /** 前情摘要（AI 生成，可编辑），续写时注入 */
  summary: string;
  created_at: number;
}

/** 设定词条（人物卡/世界观/伏笔…） */
export interface LoreEntry {
  id: number;
  project_id: number;
  category: string;
  title: string;
  content: string;
  /** 逗号分隔的触发词 */
  keywords: string;
  /** 每次续写必注入 */
  always_include: boolean;
  enabled: boolean;
  /** 视觉参考图路径（人物卡用，分镜生图时带上保证角色一致） */
  ref_image: string;
  created_at: number;
  updated_at: number;
}

export const LORE_CATEGORIES = [
  "人物",
  "世界观",
  "地点",
  "物品",
  "伏笔",
  "其他",
] as const;

/** AI 起书草稿词条 */
export interface BootstrapLore {
  category: string;
  title: string;
  content: string;
  keywords: string;
  always_include: boolean;
}

/** AI 起书草稿 */
export interface BootstrapDraft {
  name: string;
  description: string;
  /** 番茄风长简介 */
  synopsis: string;
  lore: BootstrapLore[];
}

/** 大纲节点（分卷/情节节点） */
export interface OutlineItem {
  id: number;
  project_id: number;
  title: string;
  content: string;
  order_index: number;
  /** planned / done */
  status: string;
  created_at: number;
  updated_at: number;
}

/** 体检报告元信息 */
export interface CheckReportMeta {
  id: number;
  project_id: number;
  preview: string;
  created_at: number;
}

/** 推文视频任务 */
export interface Video {
  id: number;
  project_id: number;
  title: string;
  chapter_ids: string;
  narration: string;
  /** draft → storyboarded → imaging → imaged → voicing → voiced → composing → done / error */
  status: string;
  output_path: string;
  error: string;
  created_at: number;
  updated_at: number;
}

/** 视频分镜 */
export interface VideoShot {
  id: number;
  video_id: number;
  idx: number;
  text: string;
  prompt: string;
  image_path: string;
  audio_path: string;
  duration_ms: number;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface VideoDetail {
  video: Video;
  shots: VideoShot[];
}
