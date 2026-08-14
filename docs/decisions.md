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
