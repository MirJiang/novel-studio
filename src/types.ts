export interface Project {
  id: number;
  name: string;
  /** 题材短标签（书架卡片用） */
  description: string;
  /** 番茄风长简介 */
  synopsis: string;
  /** 全书目标字数（0 = 未设置），「写完整本书」按它推算章数 */
  target_total_words: number;
  /** 每章目标字数（0 = 未设置），批量生成的默认每章篇幅 */
  target_chapter_words: number;
  /** 写作风格（0 = 不指定），对应 styles 表 */
  style_id: number;
  created_at: number;
  updated_at: number;
}

/** 写作风格（蒸馏自参考书籍样本，全局复用） */
export interface Style {
  id: number;
  name: string;
  /** 来源说明（书名 / 文件名） */
  source: string;
  /** 样本字数 */
  sample_chars: number;
  /** 蒸馏出的风格卡（写作时注入 prompt） */
  guide: string;
  /** 代表性示例片段 */
  example: string;
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
  /** 全书目标字数（可选，0/undefined = 不设置） */
  target_total_words?: number;
  /** 每章目标字数（可选） */
  target_chapter_words?: number;
  /** 写作风格 id（可选，0/undefined = 不指定） */
  style_id?: number;
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
  /** draft → storyboarded → imaging → imaged → voicing → voiced → composing → done / error；video 模式多出 videoing → videoed */
  status: string;
  /** image = 静图运镜（默认）/ video = 图生视频（Seedance 按量计费） */
  mode: string;
  /** BGM 文件路径（空 = 无） */
  bgm_path: string;
  /** BGM 音量百分比（相对配音轨） */
  bgm_volume: number;
  /** 片头/片尾素材（图片或 mp4，空 = 无） */
  intro_path: string;
  outro_path: string;
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
  /** 图生视频产物路径（空 = 未生成） */
  video_path: string;
  duration_ms: number;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface VideoDetail {
  video: Video;
  shots: VideoShot[];
}

/** 任务队列条目（批量写章 / 镜头图生视频） */
export interface Task {
  id: number;
  project_id: number;
  /** batch_chapters / video_shots */
  kind: string;
  label: string;
  /** pending / running / done / error / cancelled */
  status: string;
  payload: string;
  progress_current: number;
  progress_total: number;
  progress_label: string;
  result: string;
  error: string;
  created_at: number;
  updated_at: number;
}
