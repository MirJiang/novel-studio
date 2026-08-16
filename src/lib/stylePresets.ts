/**
 * 内置风格预设（图片画风 / 视频运镜）。
 * 词库来源：docs/research-video-2026-08.md 调研（漫剧圈教程 + 《丧尸清道夫》公开提示词 cheatsheet）。
 * 预设不落库；用户在风格库点「添加」后成为自己的风格卡（可删），guide 即注入词。
 */

export interface StylePreset {
  name: string;
  kind: "image" | "video";
  /** 注入词：图片=画风锚点；视频=运镜/运动锚点 */
  guide: string;
  /** 一句话说明（前端展示用，不入库到 guide） */
  desc: string;
}

export const IMAGE_PRESETS: StylePreset[] = [
  {
    name: "日系赛璐璐",
    kind: "image",
    guide: "日系赛璐璐动画风格，干净平涂上色，清晰轮廓线，柔和光影，色彩明快",
    desc: "推文圈最稳的动漫风，耐崩、跨镜漂移最小",
  },
  {
    name: "古风玄幻",
    kind: "image",
    guide: "古风玄幻插画，水墨氤氲质感，衣袂飘逸，电影感打光，东方美学构图",
    desc: "仙侠/古言题材标配",
  },
  {
    name: "韩系厚涂",
    kind: "image",
    guide: "韩系厚涂插画，油画般细腻质感，华丽光影，精致五官刻画，柔焦氛围",
    desc: "都市/言情封面感强",
  },
  {
    name: "写实电影感",
    kind: "image",
    guide:
      "超写实真人实景质感，IMAX 胶片机拍摄感，Panavision 镜头焦外，暖橙与海盐蓝色调，胶片颗粒，杜绝游戏 CG 感",
    desc: "《丧尸清道夫》同款锚点：摄影机+色调锁风格",
  },
  {
    name: "暗黑末世",
    kind: "image",
    guide: "暗黑末世废土风，低饱和冷色调，锈蚀与破败质感，体积光穿过尘埃",
    desc: "末世/悬疑/无限流题材",
  },
  {
    name: "扁平简笔画",
    kind: "image",
    guide: "简约扁平插画，大色块构图，圆润线条，清新马卡龙配色，极简细节",
    desc: "零成本走量路线（洛水简笔画流派）",
  },
];

export const VIDEO_PRESETS: StylePreset[] = [
  {
    name: "呼吸感手持",
    kind: "video",
    guide: "手持镜头，全程保持一种极其微弱、类似呼吸般的镜头浮动，以增强临场感",
    desc: "《丧尸清道夫》标志性咒语，临场感最强",
  },
  {
    name: "固定机位",
    kind: "video",
    guide: "固定机位，画面纹丝不动，仅人物与景物自身运动",
    desc: "最稳不易崩，适合对话/特写镜头",
  },
  {
    name: "缓慢推进",
    kind: "video",
    guide: "镜头极缓向前推进，焦点始终锁定画面主体",
    desc: "压迫感/揭示感，适合高潮前铺垫",
  },
  {
    name: "环绕运镜",
    kind: "video",
    guide: "镜头围绕主体缓慢环绕，背景视差自然流动",
    desc: "展示角色全身/场景全貌",
  },
  {
    name: "跟随镜头",
    kind: "video",
    guide: "镜头平稳跟随主体移动，如纪录片跟拍",
    desc: "行进/追逐场面",
  },
  {
    name: "空镜氛围",
    kind: "video",
    guide: "近乎静止的空镜，只有光影、微尘与远景的缓慢变化",
    desc: "转场/留白/情绪沉淀",
  },
];
