# 技术决策记录

> 每一条记录"为什么"，新加入的协作者（包括 AI）开工前必须先读。

## D1. 桌面壳：Tauri 2（否决 Electron / C#+WebView2）

- 需求画像：Windows 优先、编辑器必然是 Web 技术、重云端 API、无 Playwright 需求
- 选 Tauri 的理由：安装包 15~30MB（Electron 约 180MB）、内存占用低、
  Rust 编译期严格——本项目由 AI 生成代码、产品负责人不调试代码，
  "把错误拦在编译期"对这套协作模式价值最大
- 已知代价：Rust 首次全量编译慢；前端与 Tauri API 存在耦合（见 D5）
- 体验迭代主要发生在前端（Vite 热更新），与壳无关，编译慢不影响体验调优循环

## D2. 前端：React 18 + TypeScript + Vite + TipTap + Tailwind

- TipTap（ProseMirror 系）是长篇写作 + 划词 AI 交互的最成熟方案
- UI 用 Tailwind 手写轻量组件；shadcn/ui 留待界面复杂后按需引入

## D3. 本地数据：SQLite（rusqlite bundled + WAL）

- 作品/章节/设置全部入库；媒体文件（封面、视频）后期存作品文件夹，库里只存路径
- 单用户写作软件无并发压力，Mutex<Connection> 足够，不引入连接池
- 向量检索（设定库 RAG）预留 sqlite-vec 扩展方案，一期未启用

## D4. AI 接入层：OpenAI 兼容协议优先

- DeepSeek / 通义 / Kimi / 智谱 / OpenAI 均兼容，一套客户端全覆盖
- 流式输出走 Tauri 2 Channel 推送前端
- Claude 等非兼容协议后期以独立 provider 实现加入
- API Key 目前明文存 SQLite settings 表（本地单机），后期评估加密

## D5. 前端与后端的隔离线：src/lib/api.ts

- 前端所有后端调用收敛在 `src/lib/api.ts`（invoke 封装）
- 未来若出网页版，只需把该文件换成 fetch/SSE 实现，业务组件零改动
- **架构红线：组件里禁止直接 import @tauri-apps/api**

## D6. 内容保存策略

- 编辑器内容以 HTML 存库；字数统计前去标签
- 自动保存：800ms 防抖 + 组件卸载兜底 + AI 续写前强制落盘

## D7. 发布功能的取舍（一期不做）

- 小说平台无公开上传 API；逆向私有接口违反平台协议、有封号风险，不做
- 一期：按平台格式导出 txt；二期：半自动填充（用户自己点发布）
- 视频平台（抖音/TikTok/YouTube）有官方上传 API，届时走正规渠道

## D8. 明确不做（一期）

- 本地大模型写正文（写作质量依赖云端模型）
- 本地 LoRA 训练（角色一致性先用生图 API 的参考图能力）
- Redis/RabbitMQ 等外部中间件（桌面端不需要）

## D9. 设定库注入策略：关键词触发 + 常驻注入 + 预算硬顶

- 词条两种注入方式：`always_include` 常驻；或关键词命中前文尾部时触发
- 注入总预算 2000 字符，超预算直接截断——prompt 长度必须可预测，成本才可控
- 命中明细通过 Channel 的 meta 事件回传前端展示：注入是否生效必须对用户可见，
  否则"人设崩了"时无法定位是设定没写还是设定没注入
- 全书一致性后续路线：滚动前情摘要 + sqlite-vec 向量召回（一期先关键词，够用且可解释）

## D10. 长篇上下文 = 前情摘要 + 设定注入 + 正文尾部

- 每章可生成 150 字摘要（AI 生成、可手改），续写时注入当前章之前的全部摘要
- 摘要预算 1500 字符，超限时优先保留近期章节（久远章节的影响理应衰减）
- 摘要手动触发生成（成本可控），meta 事件会提示"前情摘要缺失"
- 划词改写/润色/扩写与续写共用同一套设定注入规则——任何 AI 输出都不许脱离人设
- 长章摘要输入截断策略：开头 3500 字 + 结尾 2000 字，兼顾主线与结局

## D11. 封面：AI 只画背景，文字程序排版

- 扩散模型渲染中文标题不可靠 → 生图 API 只出底图，书名/作者用 Rust 合成
  （image + imageproc + ab_glyph）
- 字体读 Windows 系统目录（雅黑 Bold → 雅黑 → 黑体 → 宋体），不打包子集字体
- 白字 + 深色描边：任何底图上可读，避免依赖底图明暗
- 尺寸 3:4 竖版 1536×2048（番茄/起点同比例，平台自行压缩）
- 生图协议走 OpenAI Images 兼容（火山方舟 Seedream 默认），与 LLM 层同一套设置模式
- 封面文件存 `%APPDATA%/covers/<project_id>/`，文件名时间戳排序即历史

## D12. 一致性体检基于"摘要 + 设定"，而非全文

- 全书正文远超上下文窗口，体检输入 = 全部章节摘要（预算 8000 字）+ 启用设定（4000 字）
- 因此摘要覆盖度是体检质量的地基：视图里直接显示覆盖率并提供批量补齐
- 报告流式生成、前端累积、完成后回传后端存档（check_reports 表，迁移 v3）
- 体检输出固定五节：设定冲突 / 时间线 / 伏笔台账 / 逻辑漏洞 / 总体评价，
  并要求模型"不要编造摘要中不存在的情节"（摘要粒度的检查必然偏粗，防止误报淹没真问题）

## D13. 界面设计系统：极简编辑风（方案 B）—— 已被 D14 取代

- 从 4 稿设计图（designs/ 目录下的 a/b/c/d HTML mockup）中选定 B：暖白画布 + 发丝线 + 粉彩标签
- 设计令牌集中在 `src/index.css` 的 `@theme`（Tailwind v4）：canvas/surface/line/ink/body/muted +
  四个粉彩色对（pblue/pgreen/pyellow/pred），阴影只允许 shadow-card / shadow-float 两档极轻弥散
- 规则：主按钮永远是黑底白字（bg-ink），不用彩色大按钮；不用 emoji 当图标；
  章节标题用衬线（font-display）；选中文本淡黄高亮
- 备选方向保留在 designs/ 下：A 墨韵书房（中式纸感）、C 高端暗色、D 工业蓝图，将来换肤直接对照实现

## D14. 界面设计系统：雾白毛玻璃（V3）+ 无边框窗口 —— 现行

- B 稿落地后产品负责人否掉（"太蠢"），第二轮三稿（v1 石墨 / v2 群青 / v3 雾白）选定 V3
- 窗口无边框：`tauri.conf.json` `decorations: false`，自制标题栏 `components/Caption.tsx`
  （`data-tauri-drag-region` 拖拽 + 双击最大化；最小化/最大化/关闭走 api.ts 的 win* 封装）
- V3 语言：冷灰底 #F2F3F6 + 雾白分层（white/45~70）替代 1px 描边；圆角 10~16px；
  主按钮胶囊形 + 系统蓝 #007AFF + 蓝色光晕投影；投影必须带偏移和柔化
- 图标一律内联 SVG 绘制（笔画统一），禁止用 Unicode 字符/emoji 凑数
- 令牌集中在 `src/index.css` @theme：accent/accent-soft、shadow-card/lift/float/glow
- 书架封面兜底：渐变 + 衬线书名（TILE_GRADIENTS 轮换），有封面图直接展示
- 备选 v1/v2 mockup 在 designs/ 下（v1-graphite-*.html、v2-cobalt-*.html），换肤可对照
- 未做：OS 级 Mica/Acrylic（window-vibrancy），视觉已用内部雾白分层模拟；需要时再引

## D15. 应用级导航：左侧全局导航栏（AppRail）

- 顶栏堆按钮不扩展（视频/发布/账号管理装不下）→ 60px 图标导航栏贯穿书架与写作态
- 结构：书架 / 写作 / 封面 / 体检 ‖ 视频（v0.4 占位禁用）/ 发布（v0.5 占位禁用）‖ 底部：导出、设置
- 书籍相关项在未选书时禁用；「写作」项恢复最近打开的章节（App.tsx lastChapterRef）
- 新功能 = 导航栏加一项 + App.tsx 加一个 view kind，不再动顶部布局

## D16. 推文视频流水线（v0.4 第一刀：静图运镜模式）

- 参考了 MoneyPrinterTurbo / story-flicks / novel2video / lpanda 四个开源实现，
  共性：文案→分镜→逐镜出图→TTS→字幕→ffmpeg 合成；关键体验是**分步可干预、单镜可重跑**
- 五步流水线，每步产物落库落盘：口播稿（流式 LLM，注入设定）→ 分镜（LLM 出 JSON，
  角色外貌词随设定注入保证跨镜一致）→ 逐镜生图（复用生图配置，1080x1920，可单镜重绘）
  → 配音（火山 openspeech 官方 API，按句出 mp3，ffprobe 读实际时长当时间轴）
  → 合成（ffmpeg：zoompan 推近 + concat + ASS 烧字幕 + 音画 -shortest 对齐）
- 不用 edge-tts：非官方端点违反 D7 精神；不用 whisper：按句音频时长天然对齐，零 GPU
- ffmpeg/ffprobe 分发：src-tauri/binaries/（gyan essentials 6.1.1，经 npmmirror 下载），
  探测顺序 PATH → exe 旁 binaries/；打包走 bundle.resources
- 视频预览走 asset 协议（tauri.conf assetProtocol scope $APPDATA/videos/**），不转 data URL
- 表：videos + video_shots（迁移 v4），status 状态机 draft→…→done/error
- 图生视频（可灵/即梦）与任务队列面板留待下一切片；镜头表已为此留好结构

## D17. 批量写章：后端 chat_once 逐章落库，不走流式编辑器

- ai_continue 的流式 delta 不落库（文本只到前端编辑器，靠防抖保存），后端拿不到全文，
  无法支撑"连续写 N 章"——批量生成必须换一种生成方式
- 新增 generate_chapters 命令：循环里 chat_once 拿整章全文 → text_to_html 转段落 →
  db.save_chapter 落库（word_count 自动更新）→ 立即 summarize_chapter_text 生成摘要，
  保证下一章的前情摘要链不断；摘要失败不中断，正文失败即中断（已写章节保留）
- 注入链与 ai_continue 完全一致（设定/前情摘要/大纲 ◀当前）；全新书第一章无上文时
  改注入作品简介定调；chat_once 显式 max_tokens=8192 防长章被截
- 「写完整本书」= 按作品 target_total_words 推算剩余章数（projects 表 v7 迁移加
  target_total_words / target_chapter_words 两列，0=未设置）；单次上限 50 章，
  每章字数钳制 500~10000
- 弹层（BatchWriteDialog）挂在 App 层而非 Editor 内：Editor 按 key 重挂载，
  弹层放里面切章节会丢进度；进度条复用批量摘要的 ProgressEvent 模式
- 章标题自动编号"第 N 章"，可事后改
  （补充 2）任务可取消：BatchState（running+cancel 两个 HashSet），循环在下一章开始前
  检查取消标记；已写章节保留，ProgressEvent 加 Cancelled{completed} 变体
  （补充 3）大纲自动推进：批量收尾时把本次各章摘要 + 大纲节点喂给 LLM，问"推进到第几节"，
  把对应 planned 节点标 done（章节数与节点粒度不一致，不做 1:1 硬映射）
  （补充）批量状态提升 App 层 + 悬浮进度条：生成中弹层可最小化（「后台运行」按钮/✕），
  右下角浮条实时显示进度、点击重新打开；完成/中断走 toast。后端 HashSet 防重入，
  同一作品同时只允许一个批量任务

## D18. 写作风格库：样本蒸馏风格卡，注入正文写作三件套

- 风格 = 全局资源（styles 表，v8），作品用 style_id 单选关联；删除风格自动解绑作品
- ~~样本三来源：联网搜书/粘贴链接/本地文本~~ → 联网搜书与链接抓取已下线（通用抓取太脆，
  且下载他站内容有版权争议），只保留本地 txt/粘贴文本——样本来源干净，行为可预期
- 蒸馏：样本头 6000+中 3000+尾 3000（风格贯穿全文，只看开头以偏概全）→ LLM 出六节风格卡
  （≤400 字）；示例片段程序截取，不让 LLM 引用原文（防幻觉）
- 注入点只有 ai_continue / ai_transform / generate_chapters 的 system prompt（800 字预算）；
  简介/大纲/起书不带风格——那是营销向文本，强风格适得其反
- 合规：UI 明示样本仅本地分析用，建议公版/免费授权作品；样本不落盘只进 LLM 和 DB

## D19. 番茄发布：Tauri 第二窗口 + eval 注入，fill-only 半自动

- 番茄作家后台无公开 API，社区（hchcx/rockbenben/amm10090）全走 Playwright 浏览器自动化；
  我们用 Tauri WebviewWindow 代替 Playwright——零新增重依赖，包体不变
- ~~窗口用独立 data_directory 隔离 cookie~~ → 实测自定义数据目录导致 WebView2 黑屏，
  已改回默认目录（登录态照常持久化）。番茄后台正确地址是主域路径
  fanqienovel.com/main/writer/（writer.fanqienovel.com 子域不存在）
- 命令必须 async：同步命令跑主线程，里面 sleep 会冻结事件循环、eval 永远排不上队（卡死）
- fill-only 原则（参考 amm10090 的 --fill-only）：程序只把章节标题/正文填进编辑页，
  发布/存草稿按钮永远人工点——平台对 AI 内容有申报机制，账号风险必须由人确认
- eval 无返回值，结果回传走 location.hash 通道（脚本 history.replaceState 写
  #nsfill={json} → Rust 读 w.url() 解析 → 2.5 秒后清掉 hash）。
  注意 wry 不会把 document.title 同步到原生窗口标题（显式 set 过 title 后），标题通道不可用
- 后台 DOM 选择器集中在 commands_publish.rs 顶部 FILL_SCRIPT 候选表，改版只改一处；
  React 受控输入框要走原生 value setter + input 事件才生效
- 不做：定时排期/多账号/每日上限检测（rockbenben 有实现，需要时再切片）

## D20. 任务队列：tasks 表 + 单 worker 串行，前端 2s 轮询

- 长任务（批量写章、镜头图生视频…）统一入队：tasks 表记录状态/进度/结果，
  worker 在 setup 里 tokio::spawn，Notify 唤醒，串行取 pending 执行
- Db 改 Arc<Mutex<Connection>> + Clone，worker 与命令共享连接
- 执行器签名 (AppHandle, &Db, &Task) -> Result<TaskEnd, String>（Done/Cancelled）；
  进度直接写 tasks 表（update_task_progress），不再走 Channel——
  前端 App 层 2s 轮询 + 状态跃迁检测（toast/章节实时刷新），页面刷新不丢进度
- 取消两级：pending 直接标 cancelled；running 置内存取消标志，执行器在检查点停
- 串行而非并发：LLM/生图/视频都是按量计费，串行天然限流；同类任务同作品防重复入队
- 批量写章的 Channel 版 generate_chapters 命令退役（前端改入队 + 轮询）

## D21. 图生视频：方舟 Seedance 首帧模式，复用生图 Key

- 模型 doubao-seedance-1-0-pro-250528（settings 的 video_model 可换），
  鉴权复用 img_base_url/img_api_key——不引入即梦（AK/SK 签名那套不值得）
- 异步任务：POST /contents/generations/tasks → 10s 轮询（15 分钟超时）→
  video_url 仅 24h 有效，拿到立即下载落盘（shot-{id}.mp4）
- 参数走提示词后缀（--resolution 1080p --ratio 9:16 --dur 5），官方 demo 同款
- 整批生成走任务队列（kind=video_shots，跳过已有视频的镜头，失败重试续跑）；
  单镜重跑用独立命令 generate_shot_video（不经队列）
- 合成：镜头有 video_path 就 -stream_loop 循环对齐配音时长再 concat（不再 zoompan），
  混跑兼容——静图镜头仍走老路
- 模式按视频任务选择（videos.mode：image 免费静图 / video 计费），默认静图防误触费钱

## D22. 视频 BGM / 片头片尾：合成期混音与拼接

- 素材存 videos 表（v10：bgm_path/bgm_volume/intro_path/outro_path），
  set_video_extras 把用户选的文件拷进视频产物目录（防原文件被移动；自拷贝检测防截断）
- BGM：-stream_loop -1 循环 + volume 压底（默认 15%）+ amix 与配音轨混合；
  配音轨 adelay 让过片头、apad 补齐到总长；输出显式 -t 总时长（替代 -shortest，
  否则片尾段会被配音轨长度截掉）
- 片头片尾：图片 → 2.5s 静帧段；mp4 → 直接标准化；统一 scale/crop 到 1080x1920 30fps 进 concat 列表
- -vf 与 -filter_complex 不能同用于一路流，字幕 ass 滤镜收进 filter_complex 统一编排

## D23. 视频分发：红果发不了，走抖音 fill-only

- 调研结论：红果短剧无个人 UGC 上传入口、无 API——内容机构版权方供给制
  （成片上架要备案号+版权材料，入口 www.shortdramas.com 面向版权方/编剧，不收单条视频）
- 小说推文视频的官方链路：番茄达人中心（kol.fanqieopen.com）接任务 → 发抖音挂锚点 → 回填结算
- 所以视频分发做抖音创作者中心（creator.douyin.com）的 fill-only：
  开窗口扫码登录 → 用户拖入成片 mp4（文件选择框受浏览器安全限制，JS/Eval 无法自动设置，
  Playwright 是靠 CDP setFileInputFiles 实现的，我们不引 CDP）→ eval 填充标题+话题标签 → 人工发布
- 番茄/抖音两个发布窗口共用 open_site_window + eval_and_read（location.hash 回读）一套机制

## D24. 网文方法论内置进 prompt（源自 chinese-webnovel-skill）

- 社区 skill（tomsawyerhu/chinese-webnovel-skill，605 星）不作为 skill 安装，
  而是把方法论蒸馏进应用内置 prompt——用户零配置，全中文，按我们的功能点裁剪
- 落点：SYSTEM_PROMPT（续写/批量写章：每章四件事、章内结构、场景规则、章末留后劲、去 AI 味硬规则）、
  TRANSFORM_SYSTEM_PROMPT（划词三件套：语言硬要求）、BOOTSTRAP_SYSTEM（起书：选材判断/hook 标准）、
  generate_outline（分卷四要素：卷目标/核心冲突/高潮兑现/卷末变化）、
  CHECK_SYSTEM_PROMPT（体检新增第五类：节奏与水章）
- 原 skill 的"检索本地语料模仿"环节没搬——我们的对应物是风格库（用户自己的样本蒸馏），更干净

## D25. AI 起书改多轮对话（一句话创意信息缺口太大）

- 一句话创意让 AI 猜的东西太多（题材/频道/卖点/爽点/篇幅全靠蒙）→ 改成 AI 策划主导的多轮对话
- 提问纪律写进 prompt：每轮至多 1~2 问、只挑信息缺口最大的问、2~4 轮内收敛、
  用户说"直接生成"立刻出方案——防止"问卷地狱"
- 协议：回复正文 + [DRAFT] 标记 + JSON 草稿（ai_bootstrap_chat）；标记后 JSON 解析失败时
  整段降级为普通回复（用户可继续说"重新生成"），不硬报错
- 草稿新增 target_total_words/target_chapter_words（对话里收集篇幅目标，serde default 兼容）
- 前端 AICreateWizard 重写为聊天气泡 + 草稿编辑卡（草稿出来后"换一版"= 发一句"换个方向再来一版"）

## D26. 跨章改写与合规整改：范围定位 → 确认 → 队列跑批 → 快照回滚

- 影响范围定位交给 LLM 读摘要链判断（list_summaries_with_id 带 id 喂入），
  用户勾选确认后才入队——批量改写成本高（每章一次全文级调用），确认环节防误伤
- 每章改写前备份到 chapter_backups（v12：标题/正文/摘要全量），任务面板一键回滚
  整批恢复——快照是用户敢用这功能的前提
- 改写后自动重生成该章摘要：摘要链是续写/体检/定位的数据地基，断了全书上下文就失真
- 改写 prompt 带前后章摘要并声明"不得矛盾"保连贯；>8000 字长章跳过并在结果里说明
- 合规扫描是确定性文本检索（不调 LLM，零成本零误判争议），命中清单 → 复用跨章改写入队

## D27. 模型接入协议只两套：OpenAI 兼容 + Anthropic，不为厂商写私有协议

- 文本模型：`llm.rs` 抽象 `LlmProtocol`（OpenAI chat/completions / Anthropic messages），
  `stream_chat`/`chat_once` 按协议分发；国内外主流与自定义中转（one-api/new-api/OpenRouter）
  都走这两套标准协议接入，模型覆盖面靠"协议兼容 + 自定义配置"而不是堆厂商 SDK
- Anthropic 适配点：system 抽独立字段、user/assistant 强制交替（连续同角色合并）、
  max_tokens 必填（取 8192 安全值）、SSE 按事件类型解析（content_block_delta / message_stop）
- 协议选择：`llm_protocol` 设置项（openai/anthropic/空=按域名自动识别，含 anthropic 即 Claude）；
  设置页提供厂商预设下拉（DeepSeek/OpenAI/Claude/通义/Kimi/智谱/OpenRouter）一键填地址
- 例外（生图侧唯一）：阿里云 wan2.x-image 在百炼/Token 套餐域名下没有任何 OpenAI 协议入口
  （实测 images/generations 与 chat/completions 均 400），`image_gen.rs` 按 aliyuncs.com 域名
  自动走 DashScope 原生多模态端点——这是"不修就没法用"的适配，不是新协议方向；
  图生视频（video_gen.rs）暂只有方舟协议，阿里云视频模型未适配

## D28. 视频一致性工程：统一画风字段 + 角色三视图 + 防漂移默认（源自 2026-08 调研）

- 调研存档 `docs/research-video-2026-08.md`：纯文生视频多镜头一致性 2026 年仍不可用，
  行业共识 = 分镜生图锚定风格 → 图生视频（首帧）3~5s 短镜拼接 → 合成，本项目路线不动
- `videos.style`（v13）：全片统一画风，**生成期注入**每个镜头的生图 prompt
  （`{prompt}，{style}，竖版构图，画面中无文字`）——风格与内容解耦，用户改 prompt 不用背风格词；
  分镜 LLM 被明确要求不写画风词（旧版把「古风玄幻插画」写死在 system prompt 里，换个题材就错）
- 角色三视图：`generate_lore_ref_image` 按词条内容一键出正/侧/背人设图（1920x1080）存为参考图——
  实测三视图参考比单图跨镜一致性明显更稳；分镜生图与图生视频共用同一套命中逻辑
  （`matched_lore_ref_paths`，≤3 张，参考图过多反而漂移）
- 图生视频携带角色参考图走 Seedance 2.x `reference_image`；老模型不认该角色时
  创建失败自动降级为无参考重试一次（不多花生成费，只多一次创建请求）
- 运动收敛词写死在运动 prompt（"镜头运动缓慢轻微…不变形不换脸不串色"）——
  运动幅度过大是崩坏主因；镜头时长 `video_duration` 设置项默认 5s（3~15 夹紧）
