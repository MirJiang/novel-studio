# Novel Studio

AI 小说创作工作室（Windows 桌面端）。

技术栈：**Tauri 2 + Rust + React 18 + TypeScript + TipTap + SQLite**

## 快速开始

```bash
pnpm install
pnpm tauri dev
```

首次启动后：左侧导航「设置」页填入 LLM 配置
（开发期推荐 DeepSeek：接口 `https://api.deepseek.com/v1`，模型 `deepseek-chat`），
然后新建作品 → 新建章节 → 点「AI 续写」。

## 常用命令

```bash
pnpm dev          # 只起前端（浏览器里调 UI 用）
pnpm build        # 前端构建（含 tsc 类型检查）
pnpm tauri dev    # 桌面端开发模式
pnpm tauri build  # 打 NSIS 安装包
```

## 目录结构

```text
AGENTS.md       ★ 项目交接文档：新会话/新协作者先读它
src/            React 前端（编辑器、侧栏、设置）
src/lib/api.ts  全部后端调用的唯一入口（架构红线，见 docs/decisions.md D5）
src-tauri/      Rust 后端：SQLite、LLM 流式、封面合成、命令层
docs/           产品方案与技术决策记录（改代码前先读）
scripts/        工具脚本（图标生成等）
```

## 数据位置

- 数据库：`%APPDATA%/com.novelstudio.app/novel-studio.db`

## 正式图标

应用图标由 `scripts/gen-app-icon.py`（PIL 程序化绘制）生成。修改方式：改脚本运行得到
新的 `app-icon.png`，然后执行 `pnpm tauri icon app-icon.png` 重新生成全套并重新编译。

## ffmpeg 依赖（视频合成）

`src-tauri/binaries/`（ffmpeg.exe / ffprobe.exe）因体积未入库。获取方式：
从 gyan.dev 下载 release-essentials 构建，或经 npmmirror：
`pnpm add ffmpeg-static ffprobe-static`（配 `FFMPEG_BINARIES_URL=https://cdn.npmmirror.com/binaries/ffmpeg-static`）
后从 node_modules 复制两个 exe 到 `src-tauri/binaries/` 与 `src-tauri/target/debug/binaries/`。

> 许可证提示：gyan.dev 的 ffmpeg 构建基于 GPL 组件。本仓库不分发二进制；
> 自行打包分发安装包时，需随包附带 ffmpeg 的许可证文本与源码获取方式（gyan.dev / ffmpeg.org 均有提供）。

## 免责声明

- **番茄搜书**：该功能通过番茄小说官方接口检索与采样，**仅限个人学习与写作风格分析**。
  抓取内容的版权归原平台与作者所有——请勿传播、转载或商用。若你是权利方并认为本功能不妥，
  请提 issue 或联系仓库作者，我会及时处理。
- **AI 生成内容**：续写/大纲/封面/视频等均由所配置的第三方大模型生成，准确性由使用者自行核验；
  API Key 等凭据仅保存在本机 SQLite，不上传任何服务器，但注意其为本机明文存储，请勿在不可信设备上使用。
