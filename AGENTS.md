# Novel Studio — 项目交接文档（新会话必读）

> 这份文档是项目的"记忆"。任何新会话/新协作者开工前，先读完本文 + `docs/prd.md` + `docs/decisions.md`。
> 最后更新：2026-08-15（任务队列 + 图生视频 + BGM/片头片尾 + 抖音分发）

## 一句话

AI 小说创作工作室（Windows 桌面端）：写作 → 设定库 → 封面 → 全书体检 →（规划：推文视频 → 多平台分发）。

## 协作模式（重要）

- **产品负责人不写代码**，只提供方案、思路和体验反馈；AI 负责全部开发与调试
- 工作方式：**垂直切片**——每个功能从 UI 到数据库一刀做穿，能跑能摸，再迭代
- 验收用数字说话（如"续写首字 <1.5s"），不说"感觉有点慢"
- 产品方向性讨论记录在 `docs/prd.md`，技术决策记录在 `docs/decisions.md`（D1~D12），改动架构前先查有没有相关决策

## 技术栈

Tauri 2 + Rust（后端）+ React 18 + TypeScript + Vite（前端）+ TipTap（编辑器）+ Tailwind v4 + SQLite（rusqlite bundled）

- 项目根目录：`D:\VibeCodingProject\novel-studio`
- 数据库文件：`%APPDATA%\com.novelstudio.app\novel-studio.db`（WAL 模式）
- 封面文件：`%APPDATA%\com.novelstudio.app\covers\<project_id>\cover-<时间戳>.png`

## 目录与文件职责

```text
src/
  App.tsx                     状态机：书架态（未选作品）/ 写作态（chapter/lore/cover/check）+ 导出 + toast
  types.ts                    前端类型（Project/Chapter/LoreEntry/CheckReportMeta…）
  lib/api.ts                  ★ 全部后端调用的唯一入口（架构红线，见下）
  components/
    Caption.tsx               无边框窗口标题栏：品牌 + 面包屑 + 拖拽区 + 最小化/最大化/关闭
    AppRail.tsx               应用级导航栏（贯穿书架/写作态）：书架/写作/封面/体检 + 风格库 + 视频/发布/任务 + 导出/设置
    Bookshelf.tsx             书架首页：封面卡片网格（取最新封面，无封面用渐变首字块）+ 新建作品
    Sidebar.tsx               写作态侧栏：章节/设定库双 Tab（二级面板）
    Editor.tsx                写作编辑器：续写/划词浮动条/摘要面板/自动保存
    BatchWriteDialog.tsx      批量写章弹层：N 章/写完整本书；可最小化后台跑，右下角浮条看进度（状态在 App 层）
    OutlineView.tsx           大纲视图：番茄风简介（AI 生成/手改）+ 分卷大纲（进度管控）
    LoreEditor.tsx            设定词条编辑器（分类/关键词/常驻注入/参考图/自动保存）
    CoverView.tsx             封面工坊：描述词表单（可留空，AI 按简介/设定/正文自动总结）+ 预览 + 历史缩略图
    CheckView.tsx             全书体检：摘要覆盖度 + 批量补齐 + 流式报告 + 历史
    VideoView.tsx             视频工坊：口播稿/分镜表/单镜重绘/流水线执行/成片播放
    StylesView.tsx            风格库（整页全局）：本地 txt/粘贴文本 → 蒸馏风格卡 → 应用到作品
    PublishView.tsx           发布页：章节→番茄后台填充；视频→抖音创作者中心填文案（均 fill-only，发布人工点）
    TasksView.tsx             任务面板：队列/进度/取消/重试/清理（批量写章、镜头视频等长任务）
    SettingsView.tsx          设置页（整页非弹窗，左侧分类菜单）：文本模型/封面生图/配音 TTS + 平台账号占位
src-tauri/src/
  lib.rs                      Tauri 入口：插件注册、DB 初始化、命令注册表
  db.rs                       SQLite 层：全部表 CRUD + 版本化迁移（当前 v10）
  commands.rs                 写作/设定/封面/体检等 #[tauri::command] + prompt 组装 + 注入逻辑
  commands_style.rs           风格库命令：LLM 蒸馏风格卡 + CRUD（样本由用户本地上传）
  commands_publish.rs         发布：番茄/抖音第二窗口 + eval 注入填充（location.hash 回读结果）
  commands_video.rs           视频流水线命令：口播稿/分镜/逐镜生图/镜头视频/配音/合成
  tasks.rs                    任务队列：单 worker 串行执行 + Notify 唤醒 + 入队/取消/重试/清理命令
  video_gen.rs                火山方舟 Seedance 图生视频客户端（创建任务→10s 轮询→下载落盘）
  llm.rs                      OpenAI 兼容协议客户端：stream_chat（SSE 流式）+ chat_once（非流式）
  image_gen.rs                生图 API（size 参数化）+ ab_glyph 封面排版合成
  video.rs                    火山 TTS 客户端 + ffmpeg/ffprobe 探测与合成（zoompan/concat/ASS 字幕）
src-tauri/binaries/           ffmpeg.exe + ffprobe.exe（随包分发，gyan essentials 6.1.1）
scripts/gen-icons.mjs         占位图标生成（正式图标：pnpm tauri icon）
scripts/cap.ps1               真机窗口离屏截图（PrintWindow，自检用）
scripts/a11y.ps1              真机 UI 元素枚举/按钮点击（UI Automation，自检用）
docs/prd.md                   产品方案与路线图（含完成状态）
docs/decisions.md             技术决策记录 D1~D13（为什么这么选型/这么设计）
designs/                      界面设计稿：4 种风格 mockup（a/b/c/d-*.html + shot-*.png），现用方案 B
```

## 架构红线（不许违反）

1. **前端只通过 `src/lib/api.ts` 调后端**，组件里禁止直接 import @tauri-apps/api
   （未来网页版只换这一个文件）
2. **任何 AI 输出都要过设定注入**（续写/改写/润色/扩写共用 `build_lore_section`）
3. **prompt 预算硬顶**：设定 2000 字 / 摘要 1500 字 / 前文尾部 3000 字 / 体检摘要 8000 字 / 大纲 600 字——成本可预测
4. 注入明细通过 meta 事件对用户可见（崩了能分清"没写设定"还是"没注入"）
5. 数据库改动走 `user_version` 版本化迁移（当前 v10），禁止直接改老表的 CREATE 语句了事

## 前后端协议

### 事件（Tauri Channel 推送）

```ts
// LLM 流式（llm.rs StreamEvent）
{ type: "meta", note: string }      // 注入明细，delta 之前发
{ type: "delta", text: string }     // 正文增量
{ type: "done" } | { type: "error", message: string }

// 批量任务进度（commands.rs ProgressEvent）
{ type: "progress", current, total, label }
{ type: "done" } | { type: "error", message }
```

### 命令清单（invoke 名 → 作用）

- 作品/章节：`create_project(name, description?, targetTotalWords?, targetChapterWords?)` `update_project_targets` `list_projects` `rename_project` `delete_project`（级联清磁盘目录）`create_chapter` `list_chapters` `get_chapter` `save_chapter` `delete_chapter` `save_summary`
- 设定库：`create_lore_entry` `list_lore_entries` `update_lore_entry` `delete_lore_entry` `set_lore_ref_image`（上传人物卡参考图）`remove_lore_ref_image`
- 视频：`create_video(project_id, title, chapter_ids, mode?)`（mode: image 静图运镜 / video 图生视频）`generate_shot_video`（单镜重跑）`set_video_extras`（BGM/片头片尾，素材拷入视频目录）`list_videos` `get_video_detail` `delete_video` `save_narration` `update_shot_prompt` `generate_narration`（流式）`generate_storyboard` `generate_shot_image`（单镜重绘）`generate_missing_images`（进度）`synthesize_voices`（进度）`compose_video`（进度）`open_video_folder`
- 设置：`get_setting` `set_setting`
- 导出：`export_project(project_id, path)` → txt
- 封面：`generate_cover(project_id, prompt, title, author)` → { path, data_url }；`list_covers` `get_cover_data`
- 体检：`summary_stats` `generate_missing_summaries`（进度事件）`check_consistency`（流式）`save_check_report` `list_check_reports` `get_check_report`
- 任务队列：`enqueue_batch_chapters` `enqueue_video_shots` `list_tasks` `cancel_task` `retry_task` `clear_finished_tasks`（前端 2s 轮询 tasks 表驱动浮条/toast/章节实时刷新；批量写章参数 count<=0 按全书目标字数推算，逐章落库+自动摘要+收尾推进大纲）
- 风格库：`distill_style(name, source, sample_text)` `list_styles` `delete_style` `set_project_style(project_id, style_id)`
- 发布：`open_fanqie_window` `fill_chapter_draft(chapter_id)`（番茄章节，只填不发布）
  `open_douyin_window` `fill_douyin_caption(video_id)`（抖音上传页填标题+话题；视频文件人工拖入——文件框 JS 设不了）
- AI：`ai_continue(chapter_id, instruction?, channel)` `ai_transform(chapter_id, mode, selected_text, channel)`（mode: rewrite/polish/expand）`generate_summary(chapter_id)` `ai_bootstrap_draft(idea)` `ai_bootstrap_chat_stream(messages, channel)`（对话式起书流式，[DRAFT] 草稿前端解析）`save_chat_session` `get_latest_chat_session` `list_chat_sessions` `delete_chat_session`（起书会话归档 v11）

### 设置项 key（settings 表）

- 文本：`llm_base_url`（默认 https://api.deepseek.com/v1）`llm_api_key` `llm_model`（默认 deepseek-chat）
- 生图：`img_base_url`（默认火山方舟 https://ark.cn-beijing.volces.com/api/v3）`img_api_key` `img_model`（默认 doubao-seedream-4-0-250828）
- 图生视频：`video_model`（默认 doubao-seedance-1-0-pro-250528），与 img_api_key 同一把方舟 Key（需控制台开通视频模型）
- 其他：`author_name`（封面作者名记忆）
- 配音：`tts_app_id` `tts_access_token` `tts_cluster`（默认 volcano_tts）`tts_voice`（火山控制台开通的 voice_type）
- 视频产物：`%APPDATA%\com.novelstudio.app\videos\<project_id>\<video_id>\`（镜头图/镜头 mp4/配音/中间件/final.mp4）

## 数据库 schema（v3）

```sql
projects(id, name, description/*题材短标签*/, synopsis/*番茄风长简介 v6*/,
         target_total_words, target_chapter_words/*字数目标 v7，0=未设置*/,
         style_id/*写作风格 v8，0=不指定*/, created_at, updated_at)
styles(id, name, source, sample_chars, guide/*风格卡，写作注入*/,
       example/*示例片段*/, created_at, updated_at)  /* 迁移 v8，全局表 */
chapters(id, project_id→projects CASCADE, title, content/*HTML*/, summary,
         order_index, word_count, created_at, updated_at)
lore_entries(id, project_id CASCADE, category, title, content, keywords/*逗号分隔*/,
             always_include, enabled, ref_image/*人物卡参考图，v5*/, created_at, updated_at)
settings(key PK, value)
check_reports(id, project_id CASCADE, content, created_at)
outline_items(id, project_id CASCADE, title, content, order_index,
              status/*planned/done*/, created_at, updated_at)  /* 迁移 v6，续写时注入 */
videos(id, project_id CASCADE, title, chapter_ids, narration, status, mode/*image/video v9*/,
       bgm_path, bgm_volume, intro_path, outro_path/*BGM/片头片尾 v10*/, output_path,
       error, created_at, updated_at)              /* 迁移 v4 */
video_shots(id, video_id CASCADE, idx, text, prompt, image_path, audio_path,
            video_path/*图生视频 v9*/, duration_ms, status, created_at, updated_at)  /* 迁移 v4 */
tasks(id, project_id, kind/*batch_chapters/video_shots*/, label, status, payload/*JSON*/,
      progress_current/total/label, result, error, created_at, updated_at)  /* 迁移 v9 */
```

## 已完成（v0.1~v0.3，全部构建验证通过）

- 写作：作品/章节管理、TipTap、自动保存（800ms 防抖 + 卸载兜底 + AI 前强刷）
- AI 续写：流式、注入设定库 + 前情摘要 + 前文尾部，meta 明细可见
- 划词 改写/润色/扩写：选区浮动条，位置感知流式替换（`makeInserter`）
- 设定库：关键词触发 + 常驻注入 + 预算截断
- 前情摘要：单章生成（长章取头 3500+尾 2000）/批量补齐（进度条）
- 导出 txt：系统保存对话框，html_to_text 段落转换
- 封面工坊：AI 底图 + 程序排版书名（1536×2048 3:4），历史管理
- 全书体检：设定冲突/时间线/伏笔台账/逻辑漏洞，流式报告 + 存档
- 界面：无边框窗口（自制 Caption 标题栏）+ 雾白毛玻璃设计系统（index.css @theme，见 D14）
- 导航三层：AppRail 全局导航栏（新功能加一项，视频/发布已占位）→ 书架首页 ↔ 写作态二级侧栏
  （封面/体检/视频为整页工坊，不显示写作侧栏）
- 「写作」导航项记忆最近章节，从封面/体检一键返回工作区
- 推文视频 v0.4 第一刀：口播稿（流式+设定注入）→ 分镜 JSON → 逐镜生图（可单镜重绘）
  → 火山 TTS 配音 → ffmpeg 合成（静图 zoompan 或 Seedance 镜头视频 + ASS 字幕 + BGM 混音 + 片头片尾拼接），
  视频工坊视图 + 成片播放
- 作品管理补账：书架卡片 ⋯ 菜单（重命名就地编辑 / 删除二次确认 + 磁盘目录级联清理）
- 人物卡视觉参考图：上传存 %APPDATA%/lore_refs/，分镜生图命中角色自动携带（≤3 张）
- AI 起书（对话式）：书架「AI 辅助创建」→ AI 策划多轮提问（题材/卖点/主角/爽点/篇幅，每轮至多 1~2 问），
  信息够了自动出草稿（[DRAFT] 标记 + JSON），可改可删确认后落库；可随时「直接生成」跳过问答
  （ai_bootstrap_chat_stream 流式 + AICreateWizard.tsx 整页覆盖层；会话自动存 chat_sessions 表（v11），
  「新会话」归档当前、「历史」面板可回看/继续/删除；创建成功后自动开新会话，旧的不丢）
- 作品简介与大纲：侧栏第三 Tab；番茄风简介 AI 生成/手改；分卷大纲节点可编辑可标记完成，
  进度条管控；**大纲注入续写 prompt**（600 字预算，首个未完成节点标 ◀当前）
- 批量写章：Editor「批量写章」弹层（零章节新书的空状态页也有入口）→ 后端 generate_chapters
  逐章 chat_once 落库 + 自动摘要（摘要链不断档），可最小化后台跑（右下角浮条 + toast 提醒），可中途取消（已写保留），
  章节列表随生成实时刷新，收尾时 LLM 按本次摘要自动推进大纲 ◀当前 节点；
  长任务统一走任务队列（tasks.rs worker + tasks 表 + AppRail「任务」面板）
  支持按章数或「写完整本书」（按作品目标总字数推算章数）；
  创建作品（空白/AI 向导）均可设全书目标字数 + 每章字数（projects v7 两列，0=未设置）
- 写作风格库：AppRail「风格」页，本地 txt/粘贴文本取样本 → LLM 蒸馏风格卡
  （基调/句式/用词/视角/对话/钩子，≤400 字）→ 创建作品时选用；
  注入 AI 续写/批量写章/划词三件套的 system prompt（预算 800 字，meta 明细可见"风格：XXX"）
- 发布到番茄：AppRail「发布」页 → open_fanqie_window 开番茄后台窗口（fanqienovel.com/main/writer/，扫码登录持久化免登）
  → fill_chapter_draft 把章节填进当前编辑页（fill-only，发布按钮人工点；选择器集中在 commands_publish.rs 顶部）

## 下一步

- 视频平台分发官方 API（抖音 content/create 需开发者资质；TikTok/YouTube 另说）
- 红果短剧：无个人 UGC 上传通道（机构版权方供给制），不做——见 D23

## 已知坑与注意事项

1. `pnpm create tauri-app` 在非 TTY 环境报 "not a terminal"——本项目是手工搭的骨架，别再用脚手架重建
2. 生图 API 的 `size` 参数各家要求不同：封面写死 `1536x2048`（image_gen.rs `COVER_SIZE`），
   分镜写死 `1080x1920`（commands_video.rs `SHOT_SIZE`），若火山方舟报错，按实际开通模型调
3. 封面字体依赖 Windows 系统字体（msyhbd.ttc→msyh.ttc→simhei→simsun），打包给用户用没问题，跨平台时要改
4. 应用图标是纯色占位图（`app-icon.png` + `pnpm tauri icon` 重新生成）
5. tauri-build 需要 `icons/icon.ico` 存在，删图标目录会导致构建失败
6. API Key 目前明文存 SQLite（本地单机可接受，商业化前要加密）
7. 前端 bundle 约 520KB（主要是 TipTap），桌面端可接受，后期可 code-split

## 常用命令

```bash
cd D:\VibeCodingProject\novel-studio
pnpm tauri dev     # 桌面端开发（首次后端编译几分钟，增量几秒）
pnpm build         # 前端构建（tsc 类型检查 + vite）
pnpm tauri build   # 打 NSIS 安装包
```

## 新会话开场白（复制给新会话用）

```
读 D:\VibeCodingProject\novel-studio\AGENTS.md、docs\prd.md、docs\decisions.md，
了解项目现状。我们继续开发 Novel Studio，本次任务是：【在这里写任务】
```
