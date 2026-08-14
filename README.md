# Novel Studio

AI 小说创作工作室（Windows 桌面端）。

技术栈：**Tauri 2 + Rust + React 18 + TypeScript + TipTap + SQLite**

## 快速开始

```bash
pnpm install
pnpm tauri dev
```

首次启动后：右上角「⚙ 模型设置」填入 LLM 配置
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

当前图标是占位纯色图。替换方式：准备 1024×1024 PNG 覆盖根目录
`app-icon.png`，然后执行 `pnpm tauri icon`。

## ffmpeg 依赖（视频合成）

`src-tauri/binaries/`（ffmpeg.exe / ffprobe.exe）因体积未入库。获取方式：
从 gyan.dev 下载 release-essentials 构建，或经 npmmirror：
`pnpm add ffmpeg-static ffprobe-static`（配 `FFMPEG_BINARIES_URL=https://cdn.npmmirror.com/binaries/ffmpeg-static`）
后从 node_modules 复制两个 exe 到 `src-tauri/binaries/` 与 `src-tauri/target/debug/binaries/`。
