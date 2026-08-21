//! SQLite 数据层：作品、章节、设置
//!
//! 说明：rusqlite 的 Connection 不是 Sync，这里用 Mutex 包住。
//! 写作软件是单用户低并发场景，足够用；后期如需并发再换连接池。

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

#[derive(Debug, Serialize, Clone)]
pub struct Project {
    pub id: i64,
    pub name: String,
    /// 题材短标签（书架卡片用）
    pub description: String,
    /// 番茄风长简介（作品卖点）
    pub synopsis: String,
    /// 全书目标字数（0 = 未设置），「写完整本书」按它推算章数
    pub target_total_words: i64,
    /// 每章目标字数（0 = 未设置），批量生成的默认每章篇幅
    pub target_chapter_words: i64,
    /// 写作风格（0 = 不指定），对应 styles 表
    pub style_id: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct ChapterMeta {
    pub id: i64,
    pub project_id: i64,
    pub title: String,
    pub order_index: i64,
    pub word_count: i64,
    /// 所属卷（大纲节点 id，0=未分卷）
    pub outline_item_id: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct Chapter {
    pub id: i64,
    pub project_id: i64,
    pub title: String,
    pub content: String,
    /// 前情摘要（AI 生成，可编辑），续写时注入上下文
    pub summary: String,
    pub order_index: i64,
    pub word_count: i64,
    /// 所属卷（大纲节点 id，0=未分卷）
    pub outline_item_id: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 设定词条（人物卡/世界观/地点/伏笔…）
/// keywords 为逗号分隔的触发词；always_include 为 true 时每次续写必注入
/// ref_image 为视觉参考图路径（人物卡用，生成分镜配图时带上保证角色一致）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LoreEntry {
    pub id: i64,
    pub project_id: i64,
    pub category: String,
    pub title: String,
    pub content: String,
    pub keywords: String,
    pub always_include: bool,
    pub enabled: bool,
    #[serde(default)]
    pub ref_image: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 体检报告元信息（列表用，content 单独取）
#[derive(Debug, Serialize, Clone)]
pub struct CheckReportMeta {
    pub id: i64,
    pub project_id: i64,
    pub preview: String,
    pub created_at: i64,
}

/// 推文视频（一条视频 = 一次流水线任务，状态机见 status）
#[derive(Debug, Serialize, Clone)]
pub struct Video {
    pub id: i64,
    pub project_id: i64,
    pub title: String,
    /// 取材章节 id，逗号分隔
    pub chapter_ids: String,
    /// 口播稿（AI 生成，可手改）
    pub narration: String,
    /// draft → storyboarded → imaging → voicing → composing → done / error
    pub status: String,
    /// image = 静图运镜（默认）/ video = 图生视频（Seedance，按量计费）
    pub mode: String,
    /// 全片统一画风（v13，如"古风玄幻插画"），空 = 用默认后缀；生成期注入每个镜头
    pub style: String,
    /// 运镜风格（v14，如"手持呼吸感"），空 = 只用默认收敛词；注入图生视频运动 prompt
    pub motion_style: String,
    /// BGM 文件路径（空 = 无）
    pub bgm_path: String,
    /// BGM 音量百分比（相对配音轨），默认 15
    pub bgm_volume: i64,
    /// 片头/片尾素材（图片或 mp4，空 = 无）
    pub intro_path: String,
    pub outro_path: String,
    pub output_path: String,
    pub error: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 视频分镜（一镜一行：口播句 + 画面提示词 + 产物路径）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VideoShot {
    pub id: i64,
    pub video_id: i64,
    pub idx: i64,
    /// 本镜口播句
    pub text: String,
    /// 本镜画面提示词
    pub prompt: String,
    pub image_path: String,
    pub audio_path: String,
    /// 图生视频产物（mode=video 时生成）
    pub video_path: String,
    pub duration_ms: i64,
    /// pending / imaged / voiced / error
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 写作风格（蒸馏自参考书籍样本，全局复用，创建作品时选择）
#[derive(Debug, Serialize, Clone)]
pub struct Style {
    pub id: i64,
    pub name: String,
    /// 来源说明（书名 / 链接 / 文件名）
    pub source: String,
    /// 样本字数
    pub sample_chars: i64,
    /// 蒸馏出的风格卡（写作时注入 prompt）
    pub guide: String,
    /// 代表性示例片段（前端展示）
    pub example: String,
    /// 类别（v14）：text=写作 / image=图片画风 / video=视频运镜
    pub kind: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 大纲节点（分卷/情节节点），status: planned / done
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OutlineItem {
    pub id: i64,
    pub project_id: i64,
    pub title: String,
    pub content: String,
    pub order_index: i64,
    pub status: String,
    /// 按剧情体量预估的本卷章数（0=未预估），v19
    pub target_chapters: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 待写入的设定变更（AI 提取产物）
#[derive(Debug, Clone)]
pub struct NewLoreChange {
    /// 命中的现有条目 id（None = 新登场事物）
    pub entry_id: Option<i64>,
    pub entry_title: String,
    pub category: String,
    /// new 登场 / update 变更 / retire 退场
    pub kind: String,
    pub detail: String,
}

/// 台账行（联表 chapters 带章节标题/序号）
#[derive(Debug, Serialize, Clone)]
pub struct LoreChangeRow {
    pub id: i64,
    pub chapter_id: i64,
    pub chapter_title: String,
    pub chapter_order: i64,
    pub entry_id: Option<i64>,
    pub entry_title: String,
    pub category: String,
    pub kind: String,
    pub detail: String,
    pub created_at: i64,
}

/// AI 起书的会话归档
#[derive(Debug, Serialize, Clone)]
pub struct ChatSession {
    pub id: i64,
    pub title: String,
    /// 消息列表（JSON）
    pub messages: String,
    /// 产出的草稿（JSON，空串 = 未产出）
    pub draft: String,
    /// 场景：bootstrap 起书向导 / style 风格对话（v16）
    pub scene: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 任务队列中的一条长任务（批量写章 / 视频镜头生成等）
#[derive(Debug, Serialize, Clone)]
pub struct Task {
    pub id: i64,
    pub project_id: i64,
    /// batch_chapters / video_shots
    pub kind: String,
    /// 展示名（如 "《xxx》批量写章 ×10"）
    pub label: String,
    /// pending / running / done / error / cancelled
    pub status: String,
    /// 执行参数（JSON）
    pub payload: String,
    pub progress_current: i64,
    pub progress_total: i64,
    pub progress_label: String,
    /// 完成说明（如 "新增 10 章"）
    pub result: String,
    pub error: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Db 可 Clone：任务 worker 与命令共享同一连接（内部 Arc）
#[derive(Clone)]
pub struct Db {
    conn: std::sync::Arc<Mutex<Connection>>,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 中文场景下用字符数近似字数
pub fn count_words(text: &str) -> i64 {
    text.chars().filter(|c| !c.is_whitespace()).count() as i64
}

impl Db {
    pub fn new(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).context("打开 SQLite 数据库失败")?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let db = Self {
            conn: std::sync::Arc::new(Mutex::new(conn)),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chapters (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                order_index INTEGER NOT NULL DEFAULT 0,
                word_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chapters_project
                ON chapters(project_id, order_index);

            CREATE TABLE IF NOT EXISTS lore_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                category TEXT NOT NULL DEFAULT '其他',
                title TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                keywords TEXT NOT NULL DEFAULT '',
                always_include INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_lore_project ON lore_entries(project_id);

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL DEFAULT ''
            );
            ",
        )
        .context("数据库迁移失败")?;

        // 版本化迁移：v2 给章节加摘要列（新库老库统一走 ALTER）
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 2 {
            conn.execute_batch("ALTER TABLE chapters ADD COLUMN summary TEXT NOT NULL DEFAULT '';")
                .context("迁移 v2 失败")?;
        }
        // v3：体检报告存档
        if version < 3 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS check_reports (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    content TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_reports_project ON check_reports(project_id);",
            )
            .context("迁移 v3 失败")?;
        }
        // v4：推文视频流水线（视频任务 + 分镜产物）
        if version < 4 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS videos (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    chapter_ids TEXT NOT NULL DEFAULT '',
                    narration TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'draft',
                    output_path TEXT NOT NULL DEFAULT '',
                    error TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_videos_project ON videos(project_id);

                CREATE TABLE IF NOT EXISTS video_shots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
                    idx INTEGER NOT NULL,
                    text TEXT NOT NULL DEFAULT '',
                    prompt TEXT NOT NULL DEFAULT '',
                    image_path TEXT NOT NULL DEFAULT '',
                    audio_path TEXT NOT NULL DEFAULT '',
                    duration_ms INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_shots_video ON video_shots(video_id, idx);",
            )
            .context("迁移 v4 失败")?;
        }
        conn.pragma_update(None, "user_version", 4)?;
        // v5：设定词条加视觉参考图（人物卡 → 生图一致性）
        if version < 5 {
            conn.execute_batch(
                "ALTER TABLE lore_entries ADD COLUMN ref_image TEXT NOT NULL DEFAULT '';",
            )
            .context("迁移 v5 失败")?;
        }
        conn.pragma_update(None, "user_version", 5)?;
        // v6：作品长简介 + 大纲节点表
        if version < 6 {
            conn.execute_batch(
                "ALTER TABLE projects ADD COLUMN synopsis TEXT NOT NULL DEFAULT '';
                CREATE TABLE IF NOT EXISTS outline_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL DEFAULT '',
                    order_index INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'planned',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_outline_project
                    ON outline_items(project_id, order_index);",
            )
            .context("迁移 v6 失败")?;
        }
        conn.pragma_update(None, "user_version", 6)?;
        // v7：作品字数目标（全书总字数 / 每章字数），批量生成章节用
        if version < 7 {
            conn.execute_batch(
                "ALTER TABLE projects ADD COLUMN target_total_words INTEGER NOT NULL DEFAULT 0;
                 ALTER TABLE projects ADD COLUMN target_chapter_words INTEGER NOT NULL DEFAULT 0;",
            )
            .context("迁移 v7 失败")?;
        }
        conn.pragma_update(None, "user_version", 7)?;
        // v8：写作风格库 + 作品关联风格
        if version < 8 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS styles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    source TEXT NOT NULL DEFAULT '',
                    sample_chars INTEGER NOT NULL DEFAULT 0,
                    guide TEXT NOT NULL DEFAULT '',
                    example TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                ALTER TABLE projects ADD COLUMN style_id INTEGER NOT NULL DEFAULT 0;",
            )
            .context("迁移 v8 失败")?;
        }
        conn.pragma_update(None, "user_version", 8)?;
        // v9：任务队列表 + 视频图生视频（videos.mode / video_shots.video_path）
        if version < 9 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS tasks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id INTEGER NOT NULL DEFAULT 0,
                    kind TEXT NOT NULL,
                    label TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'pending',
                    payload TEXT NOT NULL DEFAULT '{}',
                    progress_current INTEGER NOT NULL DEFAULT 0,
                    progress_total INTEGER NOT NULL DEFAULT 0,
                    progress_label TEXT NOT NULL DEFAULT '',
                    result TEXT NOT NULL DEFAULT '',
                    error TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at);
                ALTER TABLE videos ADD COLUMN mode TEXT NOT NULL DEFAULT 'image';
                ALTER TABLE video_shots ADD COLUMN video_path TEXT NOT NULL DEFAULT '';",
            )
            .context("迁移 v9 失败")?;
        }
        conn.pragma_update(None, "user_version", 9)?;
        // v10：视频 BGM / 片头片尾
        if version < 10 {
            conn.execute_batch(
                "ALTER TABLE videos ADD COLUMN bgm_path TEXT NOT NULL DEFAULT '';
                 ALTER TABLE videos ADD COLUMN bgm_volume INTEGER NOT NULL DEFAULT 15;
                 ALTER TABLE videos ADD COLUMN intro_path TEXT NOT NULL DEFAULT '';
                 ALTER TABLE videos ADD COLUMN outro_path TEXT NOT NULL DEFAULT '';",
            )
            .context("迁移 v10 失败")?;
        }
        conn.pragma_update(None, "user_version", 10)?;
        // v11：AI 起书会话归档（当前会话自动保存，旧会话可回看）
        if version < 11 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS chat_sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL DEFAULT '',
                    messages TEXT NOT NULL DEFAULT '[]',
                    draft TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );",
            )
            .context("迁移 v11 失败")?;
        }
        conn.pragma_update(None, "user_version", 11)?;
        // v12：跨章改写的章节快照（可整批回滚）
        if version < 12 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS chapter_backups (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id INTEGER NOT NULL,
                    chapter_id INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    summary TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_backups_task ON chapter_backups(task_id);",
            )
            .context("迁移 v12 失败")?;
        }
        conn.pragma_update(None, "user_version", 12)?;
        // v13：videos.style——全片统一画风，分镜生图/图生视频时统一注入，防跨镜风格漂移
        if version < 13 {
            conn.execute_batch("ALTER TABLE videos ADD COLUMN style TEXT NOT NULL DEFAULT '';")
                .context("迁移 v13 失败")?;
        }
        conn.pragma_update(None, "user_version", 13)?;
        // v14：风格库分类（text/image/video）+ 视频运动风格
        if version < 14 {
            conn.execute_batch(
                "ALTER TABLE styles ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
                 ALTER TABLE videos ADD COLUMN motion_style TEXT NOT NULL DEFAULT '';",
            )
            .context("迁移 v14 失败")?;
        }
        conn.pragma_update(None, "user_version", 14)?;
        // v15：内置写作风格（番茄爽文/古龙/知乎盐选/晋江言情），创建作品即可直选
        if version < 15 {
            Self::seed_builtin_styles(&conn)?;
        }
        conn.pragma_update(None, "user_version", 15)?;
        // v16：chat_sessions.scene——会话按场景归档（bootstrap 起书向导 / style 风格对话），历史互不串扰
        if version < 16 {
            conn.execute_batch(
                "ALTER TABLE chat_sessions ADD COLUMN scene TEXT NOT NULL DEFAULT 'bootstrap';",
            )
            .context("迁移 v16 失败")?;
        }
        conn.pragma_update(None, "user_version", 16)?;
        // v17：设定变更台账（AI 从章节提取的设定状态变化，只读查看，无审核流）
        if version < 17 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS lore_changes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
                    entry_id INTEGER,
                    entry_title TEXT NOT NULL DEFAULT '',
                    category TEXT NOT NULL DEFAULT '其他',
                    kind TEXT NOT NULL DEFAULT 'update',
                    detail TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_lore_changes_project ON lore_changes(project_id, chapter_id);",
            )
            .context("迁移 v17 失败")?;
        }
        conn.pragma_update(None, "user_version", 17)?;
        // v18：卷的概念——章节归属大纲节点（卷 = 分卷大纲节点，0=未分卷），章节列表按卷分组
        if version < 18 {
            conn.execute_batch(
                "ALTER TABLE chapters ADD COLUMN outline_item_id INTEGER NOT NULL DEFAULT 0;",
            )
            .context("迁移 v18 失败")?;
        }
        conn.pragma_update(None, "user_version", 18)?;
        // v19：outline_items.target_chapters——按剧情体量预估的各卷章数（非平均分），
        // 注入 prompt 与收卷判定用（0=未预估）
        if version < 19 {
            conn.execute_batch(
                "ALTER TABLE outline_items ADD COLUMN target_chapters INTEGER NOT NULL DEFAULT 0;",
            )
            .context("迁移 v19 失败")?;
        }
        conn.pragma_update(None, "user_version", 19)?;
        // v20：内置风格卡改版为纯文笔五节（题材/基调/钩子不进卡，理由见蒸馏 prompt）。
        // 按「仍是旧六节格式（含【整体基调】）且名字未改」识别要刷新的内置卡；
        // 旧规格下对话优化过的内置卡会一并刷成标准新版（内置卡视为系统资产，
        // 用户自己蒸馏/对话生成的卡不受影响）；新库种子本就是新版，UPDATE 空匹配
        if version < 20 {
            let ts = now();
            for (name, guide) in Self::BUILTIN_STYLES {
                conn.execute(
                    "UPDATE styles SET guide = ?1, updated_at = ?2
                     WHERE name = ?3 AND source = '内置' AND guide LIKE '%【整体基调】%'",
                    params![guide, ts, name],
                )?;
            }
        }
        conn.pragma_update(None, "user_version", 20)?;
        Ok(())
    }

    /// 内置写作风格卡（v15 首次种子；v20 改版为纯文笔五节——题材/基调/钩子由作者写书时自定，不进卡）。
    /// source=内置，与用户卡同表同权，可删
    const BUILTIN_STYLES: [(&str, &str); 4] = [
        (
            "番茄爽文风",
            "【句式与节奏】短句主导，一段一两句，动词推着走；场景切换不写过渡，直接切。
【用词偏好】口语直白，网感词点到即止；忌成语堆砌与书面腔。
【叙事视角】第三人称贴主角，心理直给，读者永远比配角知道得多。
【对话风格】对话多而短，一句一行，情绪外放，少绕弯子。
【画面与细节】细节只服务动作与反转：关键道具、表情变化，环境一笔带过。",
        ),
        (
            "古龙风",
            "【句式与节奏】极短句，频繁独行成段，留白即节奏；偶发一句收束全段。
【用词偏好】白描名词句，动词精准，几乎不用形容词；不解释，让画面说话。
【叙事视角】第三人称远视角，不进人物内心，全凭动作与选择写人。
【对话风格】对话短而有机锋，常答非所问，刀藏在客气里。
【画面与细节】写意一两笔——风、灯、刀光，氛围大于细节，从不描全貌。",
        ),
        (
            "知乎盐选风",
            "【句式与节奏】口语叙述如当面讲事，段落两三行，句句有信息增量。
【用词偏好】生活化词汇，数字与专有名词用得具体，适度自嘲。
【叙事视角】第一人称「我」贴脸，心理活动用吐槽外化，不写内心独白。
【对话风格】对话像真人聊天，会打断会呛声；关键信息借对话放出。
【画面与细节】细节取日常真实场景（楼道、工位、外卖盒），真实感优先于美感。",
        ),
        (
            "晋江言情风",
            "【句式与节奏】长短句错落，情绪高点用短句顿挫；节奏舒缓但有呼吸。
【用词偏好】精致书面语，意象化表达；情绪词克制，靠动作泄露。
【叙事视角】第三人称限知贴女主，心理细腻不絮叨，一景一情。
【对话风格】对话含蓄，言外之意与试探多；重要的话总说不出口。
【画面与细节】感官细节密——光线、气味、指尖触感，氛围先于事件。",
        ),
    ];

    /// v15 种子：内置写作风格卡（source=内置，与用户卡同表同权，可删）。
    /// 关联函数拿调用方的连接句柄——migrate 已持有锁，方法式调用会死锁
    fn seed_builtin_styles(conn: &rusqlite::Connection) -> Result<()> {
        let ts = now();
        for (name, guide) in Self::BUILTIN_STYLES {
            conn.execute(
                "INSERT INTO styles (name, source, sample_chars, guide, example, kind, created_at, updated_at)
                 VALUES (?1, '内置', 0, ?2, '', 'text', ?3, ?3)",
                params![name, guide, ts],
            )?;
        }
        Ok(())
    }

    // ---------- 作品 ----------

    pub fn create_project(
        &self,
        name: &str,
        description: &str,
        target_total_words: i64,
        target_chapter_words: i64,
        style_id: i64,
    ) -> Result<Project> {
        let conn = self.conn.lock().unwrap();
        let ts = now();
        conn.execute(
            "INSERT INTO projects (name, description, target_total_words, target_chapter_words, style_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![name, description, target_total_words, target_chapter_words, style_id, ts],
        )?;
        Ok(Project {
            id: conn.last_insert_rowid(),
            name: name.to_string(),
            description: description.to_string(),
            synopsis: String::new(),
            target_total_words,
            target_chapter_words,
            style_id,
            created_at: ts,
            updated_at: ts,
        })
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, description, synopsis, target_total_words, target_chapter_words, style_id, created_at, updated_at
             FROM projects ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Project {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                synopsis: r.get(3)?,
                target_total_words: r.get(4)?,
                target_chapter_words: r.get(5)?,
                style_id: r.get(6)?,
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 给作品指定写作风格（0 = 清除）
    pub fn set_project_style(&self, id: i64, style_id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE projects SET style_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![style_id, now(), id],
        )?;
        Ok(())
    }

    /// 更新作品字数目标（批量写章弹层可改）
    pub fn update_project_targets(
        &self,
        id: i64,
        target_total_words: i64,
        target_chapter_words: i64,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE projects SET target_total_words = ?1, target_chapter_words = ?2, updated_at = ?3 WHERE id = ?4",
            params![target_total_words, target_chapter_words, now(), id],
        )?;
        Ok(())
    }

    /// 保存作品信息（题材标签 + 长简介）
    pub fn save_project_info(&self, id: i64, description: &str, synopsis: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE projects SET description = ?1, synopsis = ?2, updated_at = ?3 WHERE id = ?4",
            params![description, synopsis, now(), id],
        )?;
        Ok(())
    }

    pub fn rename_project(&self, id: i64, name: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name, now(), id],
        )?;
        Ok(())
    }

    /// 删除作品：章节/设定/体检报告/视频经外键级联删除
    pub fn delete_project(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ---------- 章节 ----------

    pub fn create_chapter(&self, project_id: i64, title: &str) -> Result<Chapter> {
        let conn = self.conn.lock().unwrap();
        let ts = now();
        let next_index: i64 = conn.query_row(
            "SELECT COALESCE(MAX(order_index), 0) + 1 FROM chapters WHERE project_id = ?1",
            params![project_id],
            |r| r.get(0),
        )?;
        // 自动归入当前卷（首个未完成的大纲节点；无大纲/全部完成则未分卷）
        let current_volume: i64 = conn
            .query_row(
                "SELECT id FROM outline_items WHERE project_id = ?1 AND status != 'done'
                 ORDER BY order_index ASC LIMIT 1",
                params![project_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        conn.execute(
            "INSERT INTO chapters (project_id, title, order_index, outline_item_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![project_id, title, next_index, current_volume, ts],
        )?;
        Ok(Chapter {
            id: conn.last_insert_rowid(),
            project_id,
            title: title.to_string(),
            content: String::new(),
            summary: String::new(),
            order_index: next_index,
            word_count: 0,
            outline_item_id: current_volume,
            created_at: ts,
            updated_at: ts,
        })
    }

    /// 批量插入章节（本地书籍导入用）：单事务写入，word_count 现算，未分卷
    pub fn create_chapters_bulk(&self, project_id: i64, items: &[(String, String)]) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let ts = now();
        let tx = conn.transaction()?;
        for (i, (title, content)) in items.iter().enumerate() {
            let word_count = count_words(&html_to_text(content));
            tx.execute(
                "INSERT INTO chapters (project_id, title, content, order_index, word_count, outline_item_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?6)",
                params![project_id, title, content, i as i64 + 1, word_count, ts],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// 手动调整章节所属卷（0 = 未分卷）
    pub fn set_chapter_volume(&self, chapter_id: i64, outline_item_id: i64) -> Result<()> {        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE chapters SET outline_item_id = ?1 WHERE id = ?2",
            params![outline_item_id, chapter_id],
        )?;
        Ok(())
    }

    /// 各卷章数统计（续写/批量注入大纲时标注「本卷已写 N 章」用）
    pub fn count_chapters_by_outline(
        &self,
        project_id: i64,
    ) -> Result<std::collections::HashMap<i64, i64>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT outline_item_id, COUNT(*) FROM chapters WHERE project_id = ?1
             GROUP BY outline_item_id",
        )?;
        let rows = stmt.query_map(params![project_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<std::collections::HashMap<_, _>>>()?)
    }

    pub fn list_chapters(&self, project_id: i64) -> Result<Vec<ChapterMeta>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, title, order_index, word_count, outline_item_id, updated_at
             FROM chapters WHERE project_id = ?1 ORDER BY order_index ASC",
        )?;
        let rows = stmt.query_map(params![project_id], |r| {
            Ok(ChapterMeta {
                id: r.get(0)?,
                project_id: r.get(1)?,
                title: r.get(2)?,
                order_index: r.get(3)?,
                word_count: r.get(4)?,
                outline_item_id: r.get(5)?,
                updated_at: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_chapter(&self, id: i64) -> Result<Chapter> {
        let conn = self.conn.lock().unwrap();
        let chapter = conn.query_row(
            "SELECT id, project_id, title, content, summary, order_index, word_count, outline_item_id, created_at, updated_at
             FROM chapters WHERE id = ?1",
            params![id],
            |r| {
                Ok(Chapter {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    title: r.get(2)?,
                    content: r.get(3)?,
                    summary: r.get(4)?,
                    order_index: r.get(5)?,
                    word_count: r.get(6)?,
                    outline_item_id: r.get(7)?,
                    created_at: r.get(8)?,
                    updated_at: r.get(9)?,
                })
            },
        )?;
        Ok(chapter)
    }

    pub fn save_chapter(&self, id: i64, title: &str, content: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let word_count = count_words(&html_to_text(content));
        conn.execute(
            "UPDATE chapters SET title = ?1, content = ?2, word_count = ?3, updated_at = ?4
             WHERE id = ?5",
            params![title, content, word_count, now(), id],
        )?;
        Ok(())
    }

    /// 全书最后一章（按 order_index 最大，容忍删章后的空洞）
    pub fn last_chapter(&self, project_id: i64) -> Result<Option<Chapter>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, title, content, summary, order_index, word_count, outline_item_id, created_at, updated_at
             FROM chapters WHERE project_id = ?1 ORDER BY order_index DESC LIMIT 1",
        )?;
        let mut rows = stmt.query_map(params![project_id], |r| {
            Ok(Chapter {
                id: r.get(0)?,
                project_id: r.get(1)?,
                title: r.get(2)?,
                content: r.get(3)?,
                summary: r.get(4)?,
                order_index: r.get(5)?,
                word_count: r.get(6)?,
                outline_item_id: r.get(7)?,
                created_at: r.get(8)?,
                updated_at: r.get(9)?,
            })
        })?;
        Ok(rows.next().transpose()?)
    }

    /// 全书已写总字数（所有章 word_count 求和）
    pub fn total_word_count(&self, project_id: i64) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let total: i64 = conn.query_row(
            "SELECT COALESCE(SUM(word_count), 0) FROM chapters WHERE project_id = ?1",
            params![project_id],
            |r| r.get(0),
        )?;
        Ok(total)
    }

    /// 章节总数（批量生成自动编号用）
    pub fn chapter_count(&self, project_id: i64) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM chapters WHERE project_id = ?1",
            params![project_id],
            |r| r.get(0),
        )?;
        Ok(count)
    }

    pub fn save_summary(&self, id: i64, summary: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE chapters SET summary = ?1 WHERE id = ?2",
            params![summary, id],
        )?;
        Ok(())
    }

    /// 当前章节之前所有章节的摘要（按顺序），用于长篇上下文
    pub fn list_summaries_before(
        &self,
        project_id: i64,
        order_index: i64,
    ) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT title, summary FROM chapters
             WHERE project_id = ?1 AND order_index < ?2 AND summary != ''
             ORDER BY order_index ASC",
        )?;
        let rows = stmt.query_map(params![project_id, order_index], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 某章之后所有章的摘要（改写章节时保后续连贯用）
    pub fn list_summaries_after(
        &self,
        project_id: i64,
        order_index: i64,
    ) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT title, summary FROM chapters
             WHERE project_id = ?1 AND order_index > ?2 AND summary != ''
             ORDER BY order_index ASC",
        )?;
        let rows = stmt.query_map(params![project_id, order_index], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 全书章节摘要（带章节 id，跨章改写定位影响范围用）
    pub fn list_summaries_with_id(&self, project_id: i64) -> Result<Vec<(i64, String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, summary FROM chapters
             WHERE project_id = ?1 AND summary != '' ORDER BY order_index ASC",
        )?;
        let rows = stmt.query_map(params![project_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 导出用：整本书的 (标题, 正文)，按章节顺序
    pub fn list_chapter_bodies(&self, project_id: i64) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT title, content FROM chapters
             WHERE project_id = ?1 ORDER BY order_index ASC",
        )?;
        let rows = stmt.query_map(params![project_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 缺摘要的章节（批量生成摘要用）
    pub fn list_chapters_missing_summary(&self, project_id: i64) -> Result<Vec<Chapter>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, title, content, summary, order_index, word_count, outline_item_id, created_at, updated_at
             FROM chapters WHERE project_id = ?1 AND summary = ''
             ORDER BY order_index ASC",
        )?;
        let rows = stmt.query_map(params![project_id], |r| {
            Ok(Chapter {
                id: r.get(0)?,
                project_id: r.get(1)?,
                title: r.get(2)?,
                content: r.get(3)?,
                summary: r.get(4)?,
                order_index: r.get(5)?,
                word_count: r.get(6)?,
                outline_item_id: r.get(7)?,
                created_at: r.get(8)?,
                updated_at: r.get(9)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// (总章节数, 已有摘要数)
    pub fn summary_stats(&self, project_id: i64) -> Result<(i64, i64)> {
        let conn = self.conn.lock().unwrap();
        let total: i64 = conn.query_row(
            "SELECT COUNT(*) FROM chapters WHERE project_id = ?1",
            params![project_id],
            |r| r.get(0),
        )?;
        let with_summary: i64 = conn.query_row(
            "SELECT COUNT(*) FROM chapters WHERE project_id = ?1 AND summary != ''",
            params![project_id],
            |r| r.get(0),
        )?;
        Ok((total, with_summary))
    }

    // ---------- 体检报告 ----------

    pub fn save_check_report(&self, project_id: i64, content: &str) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO check_reports (project_id, content, created_at) VALUES (?1, ?2, ?3)",
            params![project_id, content, now()],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn list_check_reports(&self, project_id: i64) -> Result<Vec<CheckReportMeta>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, substr(content, 1, 80), created_at
             FROM check_reports WHERE project_id = ?1 ORDER BY id DESC",
        )?;
        let rows = stmt.query_map(params![project_id], |r| {
            Ok(CheckReportMeta {
                id: r.get(0)?,
                project_id: r.get(1)?,
                preview: r.get(2)?,
                created_at: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_check_report(&self, id: i64) -> Result<String> {
        let conn = self.conn.lock().unwrap();
        let content = conn.query_row(
            "SELECT content FROM check_reports WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        Ok(content)
    }

    pub fn delete_chapter(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM chapters WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ---------- 设定库 ----------

    pub fn create_lore_entry(
        &self,
        project_id: i64,
        title: &str,
        category: &str,
    ) -> Result<LoreEntry> {
        let conn = self.conn.lock().unwrap();
        let ts = now();
        conn.execute(
            "INSERT INTO lore_entries (project_id, title, category, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![project_id, title, category, ts],
        )?;
        Ok(LoreEntry {
            id: conn.last_insert_rowid(),
            project_id,
            category: category.to_string(),
            title: title.to_string(),
            content: String::new(),
            keywords: String::new(),
            always_include: false,
            enabled: true,
            ref_image: String::new(),
            created_at: ts,
            updated_at: ts,
        })
    }

    pub fn list_lore_entries(&self, project_id: i64) -> Result<Vec<LoreEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, category, title, content, keywords,
                    always_include, enabled, ref_image, created_at, updated_at
             FROM lore_entries WHERE project_id = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![project_id], |r| {
            Ok(LoreEntry {
                id: r.get(0)?,
                project_id: r.get(1)?,
                category: r.get(2)?,
                title: r.get(3)?,
                content: r.get(4)?,
                keywords: r.get(5)?,
                always_include: r.get(6)?,
                enabled: r.get(7)?,
                ref_image: r.get(8)?,
                created_at: r.get(9)?,
                updated_at: r.get(10)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 设置/清除词条的视觉参考图（update_lore_entry 不动该字段，避免编辑器全量保存时覆盖）
    pub fn set_lore_ref_image(&self, id: i64, path: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE lore_entries SET ref_image = ?1, updated_at = ?2 WHERE id = ?3",
            params![path, now(), id],
        )?;
        Ok(())
    }

    pub fn get_lore_entry(&self, id: i64) -> Result<LoreEntry> {
        let conn = self.conn.lock().unwrap();
        let e = conn.query_row(
            "SELECT id, project_id, category, title, content, keywords,
                    always_include, enabled, ref_image, created_at, updated_at
             FROM lore_entries WHERE id = ?1",
            params![id],
            |r| {
                Ok(LoreEntry {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    category: r.get(2)?,
                    title: r.get(3)?,
                    content: r.get(4)?,
                    keywords: r.get(5)?,
                    always_include: r.get(6)?,
                    enabled: r.get(7)?,
                    ref_image: r.get(8)?,
                    created_at: r.get(9)?,
                    updated_at: r.get(10)?,
                })
            },
        )?;
        Ok(e)
    }

    pub fn update_lore_entry(&self, e: &LoreEntry) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE lore_entries
             SET title = ?1, category = ?2, content = ?3, keywords = ?4,
                 always_include = ?5, enabled = ?6, updated_at = ?7
             WHERE id = ?8",
            params![
                e.title,
                e.category,
                e.content,
                e.keywords,
                e.always_include,
                e.enabled,
                now(),
                e.id
            ],
        )?;
        Ok(())
    }

    pub fn delete_lore_entry(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM lore_entries WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ---------- 大纲 ----------

    pub fn list_outline(&self, project_id: i64) -> Result<Vec<OutlineItem>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, title, content, order_index, status, target_chapters, created_at, updated_at
             FROM outline_items WHERE project_id = ?1 ORDER BY order_index ASC",
        )?;
        let rows = stmt.query_map(params![project_id], |r| {
            Ok(OutlineItem {
                id: r.get(0)?,
                project_id: r.get(1)?,
                title: r.get(2)?,
                content: r.get(3)?,
                order_index: r.get(4)?,
                status: r.get(5)?,
                target_chapters: r.get(6)?,
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn add_outline_item(&self, project_id: i64, title: &str) -> Result<OutlineItem> {
        let conn = self.conn.lock().unwrap();
        let ts = now();
        let next: i64 = conn.query_row(
            "SELECT COALESCE(MAX(order_index), 0) + 1 FROM outline_items WHERE project_id = ?1",
            params![project_id],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO outline_items (project_id, title, order_index, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![project_id, title, next, ts],
        )?;
        Ok(OutlineItem {
            id: conn.last_insert_rowid(),
            project_id,
            title: title.to_string(),
            content: String::new(),
            order_index: next,
            status: "planned".to_string(),
            target_chapters: 0,
            created_at: ts,
            updated_at: ts,
        })
    }

    pub fn save_outline_item(
        &self,
        id: i64,
        title: &str,
        content: &str,
        target_chapters: i64,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE outline_items SET title = ?1, content = ?2, target_chapters = ?3, updated_at = ?4 WHERE id = ?5",
            params![title, content, target_chapters.max(0), now(), id],
        )?;
        Ok(())
    }

    pub fn set_outline_status(&self, id: i64, status: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE outline_items SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status, now(), id],
        )?;
        Ok(())
    }

    pub fn delete_outline_item(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM outline_items WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// AI 生成大纲后整表替换（title, content, target_chapters 三元组）
    pub fn replace_outline(&self, project_id: i64, items: &[(String, String, i64)]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM outline_items WHERE project_id = ?1",
            params![project_id],
        )?;
        let ts = now();
        for (i, (title, content, target)) in items.iter().enumerate() {
            conn.execute(
                "INSERT INTO outline_items (project_id, title, content, order_index, target_chapters, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![project_id, title, content, i as i64 + 1, target.max(&0), ts],
            )?;
        }
        Ok(())
    }

    // ---------- 推文视频 ----------

    pub fn create_video(
        &self,
        project_id: i64,
        title: &str,
        chapter_ids: &str,
        mode: &str,
        style: &str,
        motion_style: &str,
    ) -> Result<Video> {
        let conn = self.conn.lock().unwrap();
        let ts = now();
        conn.execute(
            "INSERT INTO videos (project_id, title, chapter_ids, mode, style, motion_style, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![project_id, title, chapter_ids, mode, style, motion_style, ts],
        )?;
        Ok(Video {
            id: conn.last_insert_rowid(),
            project_id,
            title: title.to_string(),
            chapter_ids: chapter_ids.to_string(),
            narration: String::new(),
            status: "draft".to_string(),
            mode: mode.to_string(),
            style: style.to_string(),
            motion_style: motion_style.to_string(),
            bgm_path: String::new(),
            bgm_volume: 15,
            intro_path: String::new(),
            outro_path: String::new(),
            output_path: String::new(),
            error: String::new(),
            created_at: ts,
            updated_at: ts,
        })
    }

    pub fn list_videos(&self, project_id: i64) -> Result<Vec<Video>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, title, chapter_ids, narration, status, mode, bgm_path, bgm_volume, intro_path, outro_path, output_path, error, created_at, updated_at, style, motion_style
             FROM videos WHERE project_id = ?1 ORDER BY id DESC",
        )?;
        let rows = stmt.query_map(params![project_id], |r| {
            Ok(Video {
                id: r.get(0)?,
                project_id: r.get(1)?,
                title: r.get(2)?,
                chapter_ids: r.get(3)?,
                narration: r.get(4)?,
                status: r.get(5)?,
                mode: r.get(6)?,
                bgm_path: r.get(7)?,
                bgm_volume: r.get(8)?,
                intro_path: r.get(9)?,
                outro_path: r.get(10)?,
                output_path: r.get(11)?,
                error: r.get(12)?,
                created_at: r.get(13)?,
                updated_at: r.get(14)?,
                style: r.get(15)?,
                motion_style: r.get(16)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_video(&self, id: i64) -> Result<Video> {
        let conn = self.conn.lock().unwrap();
        let v = conn.query_row(
            "SELECT id, project_id, title, chapter_ids, narration, status, mode, bgm_path, bgm_volume, intro_path, outro_path, output_path, error, created_at, updated_at, style, motion_style
             FROM videos WHERE id = ?1",
            params![id],
            |r| {
                Ok(Video {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    title: r.get(2)?,
                    chapter_ids: r.get(3)?,
                    narration: r.get(4)?,
                    status: r.get(5)?,
                    mode: r.get(6)?,
                    bgm_path: r.get(7)?,
                    bgm_volume: r.get(8)?,
                    intro_path: r.get(9)?,
                    outro_path: r.get(10)?,
                    output_path: r.get(11)?,
                    error: r.get(12)?,
                    created_at: r.get(13)?,
                    updated_at: r.get(14)?,
                    style: r.get(15)?,
                motion_style: r.get(16)?,
                })
            },
        )?;
        Ok(v)
    }

    pub fn save_narration(&self, id: i64, narration: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE videos SET narration = ?1, updated_at = ?2 WHERE id = ?3",
            params![narration, now(), id],
        )?;
        Ok(())
    }

    pub fn set_video_status(&self, id: i64, status: &str, error: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE videos SET status = ?1, error = ?2, updated_at = ?3 WHERE id = ?4",
            params![status, error, now(), id],
        )?;
        Ok(())
    }

    /// 设置全片统一画风（生成期注入每个镜头的生图/运动 prompt）
    pub fn set_video_style(&self, id: i64, style: &str, motion_style: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE videos SET style = ?1, motion_style = ?2, updated_at = ?3 WHERE id = ?4",
            params![style, motion_style, now(), id],
        )?;
        Ok(())
    }

    /// 设置 BGM / 片头片尾（路径为已拷入视频目录的产物）
    pub fn set_video_extras(
        &self,
        id: i64,
        bgm_path: &str,
        bgm_volume: i64,
        intro_path: &str,
        outro_path: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE videos SET bgm_path = ?1, bgm_volume = ?2, intro_path = ?3, outro_path = ?4, updated_at = ?5
             WHERE id = ?6",
            params![bgm_path, bgm_volume, intro_path, outro_path, now(), id],
        )?;
        Ok(())
    }

    pub fn set_video_output(&self, id: i64, path: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE videos SET output_path = ?1, status = 'done', updated_at = ?2 WHERE id = ?3",
            params![path, now(), id],
        )?;
        Ok(())
    }

    pub fn delete_video(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM videos WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// 分镜重生成：整表替换（旧的镜头产物记录清掉）
    pub fn replace_shots(&self, video_id: i64, drafts: &[(String, String)]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM video_shots WHERE video_id = ?1",
            params![video_id],
        )?;
        let ts = now();
        for (i, (text, prompt)) in drafts.iter().enumerate() {
            conn.execute(
                "INSERT INTO video_shots (video_id, idx, text, prompt, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![video_id, i as i64 + 1, text, prompt, ts],
            )?;
        }
        conn.execute(
            "UPDATE videos SET status = 'storyboarded', updated_at = ?1 WHERE id = ?2",
            params![ts, video_id],
        )?;
        Ok(())
    }

    pub fn list_shots(&self, video_id: i64) -> Result<Vec<VideoShot>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, video_id, idx, text, prompt, image_path, audio_path, video_path, duration_ms, status, created_at, updated_at
             FROM video_shots WHERE video_id = ?1 ORDER BY idx ASC",
        )?;
        let rows = stmt.query_map(params![video_id], |r| {
            Ok(VideoShot {
                id: r.get(0)?,
                video_id: r.get(1)?,
                idx: r.get(2)?,
                text: r.get(3)?,
                prompt: r.get(4)?,
                image_path: r.get(5)?,
                audio_path: r.get(6)?,
                video_path: r.get(7)?,
                duration_ms: r.get(8)?,
                status: r.get(9)?,
                created_at: r.get(10)?,
                updated_at: r.get(11)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_shot(&self, id: i64) -> Result<VideoShot> {
        let conn = self.conn.lock().unwrap();
        let s = conn.query_row(
            "SELECT id, video_id, idx, text, prompt, image_path, audio_path, video_path, duration_ms, status, created_at, updated_at
             FROM video_shots WHERE id = ?1",
            params![id],
            |r| {
                Ok(VideoShot {
                    id: r.get(0)?,
                    video_id: r.get(1)?,
                    idx: r.get(2)?,
                    text: r.get(3)?,
                    prompt: r.get(4)?,
                    image_path: r.get(5)?,
                    audio_path: r.get(6)?,
                    video_path: r.get(7)?,
                    duration_ms: r.get(8)?,
                    status: r.get(9)?,
                    created_at: r.get(10)?,
                    updated_at: r.get(11)?,
                })
            },
        )?;
        Ok(s)
    }

    pub fn update_shot_prompt(&self, shot_id: i64, prompt: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE video_shots SET prompt = ?1, updated_at = ?2 WHERE id = ?3",
            params![prompt, now(), shot_id],
        )?;
        Ok(())
    }

    /// 写入镜头的图生视频产物路径
    pub fn set_shot_video(&self, shot_id: i64, video_path: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE video_shots SET video_path = ?1, updated_at = ?2 WHERE id = ?3",
            params![video_path, now(), shot_id],
        )?;
        Ok(())
    }

    pub fn set_shot_image(&self, shot_id: i64, path: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE video_shots SET image_path = ?1, status = 'imaged', updated_at = ?2 WHERE id = ?3",
            params![path, now(), shot_id],
        )?;
        Ok(())
    }

    pub fn set_shot_audio(&self, shot_id: i64, path: &str, duration_ms: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE video_shots SET audio_path = ?1, duration_ms = ?2, status = 'voiced', updated_at = ?3 WHERE id = ?4",
            params![path, duration_ms, now(), shot_id],
        )?;
        Ok(())
    }

    // ---------- 设置 ----------

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        Ok(rows.next()?.map(|r| r.get(0)).transpose()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    // ---------- 写作风格 ----------

    pub fn create_style(
        &self,
        name: &str,
        source: &str,
        sample_chars: i64,
        guide: &str,
        example: &str,
        kind: &str,
    ) -> Result<Style> {
        let conn = self.conn.lock().unwrap();
        let ts = now();
        conn.execute(
            "INSERT INTO styles (name, source, sample_chars, guide, example, kind, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![name, source, sample_chars, guide, example, kind, ts],
        )?;
        Ok(Style {
            id: conn.last_insert_rowid(),
            name: name.to_string(),
            source: source.to_string(),
            sample_chars,
            guide: guide.to_string(),
            example: example.to_string(),
            kind: kind.to_string(),
            created_at: ts,
            updated_at: ts,
        })
    }

    /// 更新风格卡（对话优化后保存：只动名称与卡内容，来源/样本信息保留）
    pub fn update_style(&self, id: i64, name: &str, guide: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE styles SET name = ?1, guide = ?2, updated_at = ?3 WHERE id = ?4",
            params![name, guide, now(), id],
        )?;
        Ok(())
    }

    // ---------- 设定变更台账 ----------

    /// 整章替换该章的变更记录（重复提取幂等：先删后插）
    pub fn replace_lore_changes(
        &self,
        project_id: i64,
        chapter_id: i64,
        rows: &[NewLoreChange],
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM lore_changes WHERE chapter_id = ?1",
            params![chapter_id],
        )?;
        let ts = now();
        for r in rows {
            conn.execute(
                "INSERT INTO lore_changes (project_id, chapter_id, entry_id, entry_title, category, kind, detail, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![project_id, chapter_id, r.entry_id, r.entry_title, r.category, r.kind, r.detail, ts],
            )?;
        }
        Ok(())
    }

    /// 台账列表（联表带章节标题/序号，新的章在前）；
    /// entry_id/entry_title 给值时按条目过滤（条目编辑器的时间线用）
    pub fn list_lore_changes(
        &self,
        project_id: i64,
        entry_id: Option<i64>,
        entry_title: Option<&str>,
    ) -> Result<Vec<LoreChangeRow>> {
        let conn = self.conn.lock().unwrap();
        let filter_entry = entry_id.is_some() || entry_title.is_some();
        let sql = if filter_entry {
            "SELECT c.id, c.chapter_id, ch.title, ch.order_index, c.entry_id, c.entry_title, c.category, c.kind, c.detail, c.created_at
             FROM lore_changes c JOIN chapters ch ON ch.id = c.chapter_id
             WHERE c.project_id = ?1 AND (c.entry_id = ?2 OR c.entry_title = ?3)
             ORDER BY ch.order_index DESC, c.id DESC"
        } else {
            "SELECT c.id, c.chapter_id, ch.title, ch.order_index, c.entry_id, c.entry_title, c.category, c.kind, c.detail, c.created_at
             FROM lore_changes c JOIN chapters ch ON ch.id = c.chapter_id
             WHERE c.project_id = ?1
             ORDER BY ch.order_index DESC, c.id DESC"
        };
        let mut stmt = conn.prepare(sql)?;
        let map = |r: &rusqlite::Row| -> rusqlite::Result<LoreChangeRow> {
            Ok(LoreChangeRow {
                id: r.get(0)?,
                chapter_id: r.get(1)?,
                chapter_title: r.get(2)?,
                chapter_order: r.get(3)?,
                entry_id: r.get(4)?,
                entry_title: r.get(5)?,
                category: r.get(6)?,
                kind: r.get(7)?,
                detail: r.get(8)?,
                created_at: r.get(9)?,
            })
        };
        let rows = if filter_entry {
            stmt.query_map(
                params![project_id, entry_id.unwrap_or(0), entry_title.unwrap_or("")],
                map,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            stmt.query_map(params![project_id], map)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        Ok(rows)
    }

    pub fn list_styles(&self) -> Result<Vec<Style>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, source, sample_chars, guide, example, kind, created_at, updated_at
             FROM styles ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Style {
                id: r.get(0)?,
                name: r.get(1)?,
                source: r.get(2)?,
                sample_chars: r.get(3)?,
                guide: r.get(4)?,
                example: r.get(5)?,
                kind: r.get(6)?,
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_style(&self, id: i64) -> Result<Option<Style>> {
        Ok(self.list_styles()?.into_iter().find(|s| s.id == id))
    }

    pub fn delete_style(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM styles WHERE id = ?1", params![id])?;
        // 引用该风格的作品一并解除关联
        conn.execute(
            "UPDATE projects SET style_id = 0 WHERE style_id = ?1",
            params![id],
        )?;
        Ok(())
    }

    // ---------- 任务队列 ----------

    pub fn create_task(
        &self,
        project_id: i64,
        kind: &str,
        label: &str,
        payload: &str,
    ) -> Result<Task> {
        let conn = self.conn.lock().unwrap();
        let ts = now();
        conn.execute(
            "INSERT INTO tasks (project_id, kind, label, payload, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![project_id, kind, label, payload, ts],
        )?;
        Ok(Task {
            id: conn.last_insert_rowid(),
            project_id,
            kind: kind.to_string(),
            label: label.to_string(),
            status: "pending".to_string(),
            payload: payload.to_string(),
            progress_current: 0,
            progress_total: 0,
            progress_label: String::new(),
            result: String::new(),
            error: String::new(),
            created_at: ts,
            updated_at: ts,
        })
    }

    fn row_to_task(r: &rusqlite::Row) -> rusqlite::Result<Task> {
        Ok(Task {
            id: r.get(0)?,
            project_id: r.get(1)?,
            kind: r.get(2)?,
            label: r.get(3)?,
            status: r.get(4)?,
            payload: r.get(5)?,
            progress_current: r.get(6)?,
            progress_total: r.get(7)?,
            progress_label: r.get(8)?,
            result: r.get(9)?,
            error: r.get(10)?,
            created_at: r.get(11)?,
            updated_at: r.get(12)?,
        })
    }

    const TASK_COLS: &'static str = "id, project_id, kind, label, status, payload, \
        progress_current, progress_total, progress_label, result, error, created_at, updated_at";

    pub fn list_tasks(&self) -> Result<Vec<Task>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM tasks ORDER BY id DESC LIMIT 100",
            Self::TASK_COLS
        ))?;
        let rows = stmt.query_map([], Self::row_to_task)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_task(&self, id: i64) -> Result<Task> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.query_row(
            &format!("SELECT {} FROM tasks WHERE id = ?1", Self::TASK_COLS),
            params![id],
            Self::row_to_task,
        )?)
    }

    /// 取最早的一条 pending 任务并置为 running（单 worker 串行，无需原子化）
    pub fn take_next_pending_task(&self) -> Result<Option<Task>> {
        let conn = self.conn.lock().unwrap();
        let task = {
            let mut stmt = conn.prepare(&format!(
                "SELECT {} FROM tasks WHERE status = 'pending' ORDER BY id ASC LIMIT 1",
                Self::TASK_COLS
            ))?;
            let mut rows = stmt.query_map([], Self::row_to_task)?;
            rows.next().transpose()?
        };
        if let Some(t) = task {
            conn.execute(
                "UPDATE tasks SET status = 'running', updated_at = ?1 WHERE id = ?2",
                params![now(), t.id],
            )?;
            return Ok(Some(t));
        }
        Ok(None)
    }

    pub fn update_task_progress(
        &self,
        id: i64,
        current: i64,
        total: i64,
        label: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tasks SET progress_current = ?1, progress_total = ?2, progress_label = ?3, updated_at = ?4
             WHERE id = ?5",
            params![current, total, label, now(), id],
        )?;
        Ok(())
    }

    /// 任务收尾：done / error / cancelled
    pub fn finish_task(&self, id: i64, status: &str, result: &str, error: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tasks SET status = ?1, result = ?2, error = ?3, updated_at = ?4 WHERE id = ?5",
            params![status, result, error, now(), id],
        )?;
        Ok(())
    }

    /// 同作品是否已有未完结的同类任务（防重复入队）
    pub fn has_active_task(&self, project_id: i64, kind: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM tasks WHERE project_id = ?1 AND kind = ?2
             AND status IN ('pending', 'running')",
            params![project_id, kind],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    /// 启动恢复：上次退出时还在 running 的任务标记为中断错误
    pub fn interrupt_running_tasks(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tasks SET status = 'error', error = '应用重启，任务中断（可重试，已完成的部分保留）', updated_at = ?1
             WHERE status IN ('running', 'paused')",
            params![now()],
        )?;
        Ok(())
    }

    /// 暂停的任务重新排队（可附带扣减后的 payload）
    pub fn reset_task_to_pending(&self, id: i64, payload: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tasks SET status = 'pending', payload = ?1, updated_at = ?2 WHERE id = ?3",
            params![payload, now(), id],
        )?;
        Ok(())
    }

    /// 清理已完结任务（done/error/cancelled）
    pub fn clear_finished_tasks(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM tasks WHERE status IN ('done', 'error', 'cancelled')",
            [],
        )?;
        Ok(())
    }

    // ---------- AI 起书会话归档 ----------

    /// 保存会话：id 为 None 新建（记入 scene），否则按 id 更新；返回会话 id
    pub fn save_chat_session(
        &self,
        id: Option<i64>,
        title: &str,
        messages: &str,
        draft: &str,
        scene: &str,
    ) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let ts = now();
        match id {
            Some(sid) => {
                conn.execute(
                    "UPDATE chat_sessions SET title = ?1, messages = ?2, draft = ?3, updated_at = ?4 WHERE id = ?5",
                    params![title, messages, draft, ts, sid],
                )?;
                Ok(sid)
            }
            None => {
                conn.execute(
                    "INSERT INTO chat_sessions (title, messages, draft, scene, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                    params![title, messages, draft, scene, ts],
                )?;
                Ok(conn.last_insert_rowid())
            }
        }
    }

    fn row_to_chat_session(r: &rusqlite::Row) -> rusqlite::Result<ChatSession> {
        Ok(ChatSession {
            id: r.get(0)?,
            title: r.get(1)?,
            messages: r.get(2)?,
            draft: r.get(3)?,
            created_at: r.get(4)?,
            updated_at: r.get(5)?,
            scene: r.get(6)?,
        })
    }

    /// 最近的一条会话（按场景过滤，进入向导/风格对话时恢复）
    pub fn latest_chat_session(&self, scene: &str) -> Result<Option<ChatSession>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, messages, draft, created_at, updated_at, scene
             FROM chat_sessions WHERE scene = ?1 ORDER BY updated_at DESC LIMIT 1",
        )?;
        let mut rows = stmt.query_map(params![scene], Self::row_to_chat_session)?;
        Ok(rows.next().transpose()?)
    }

    /// 全部会话（按场景过滤，新→旧，归档列表用）
    pub fn list_chat_sessions(&self, scene: &str) -> Result<Vec<ChatSession>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, messages, draft, created_at, updated_at, scene
             FROM chat_sessions WHERE scene = ?1 ORDER BY updated_at DESC LIMIT 50",
        )?;
        let rows = stmt.query_map(params![scene], Self::row_to_chat_session)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn delete_chat_session(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM chat_sessions WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ---------- 跨章改写快照 ----------

    /// 改写前备份章节现状（标题/正文/摘要）
    pub fn backup_chapter(&self, task_id: i64, chapter_id: i64) -> Result<()> {
        let ch = self.get_chapter(chapter_id)?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO chapter_backups (task_id, chapter_id, title, content, summary, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![task_id, chapter_id, ch.title, ch.content, ch.summary, now()],
        )?;
        Ok(())
    }

    /// 任务的快照列表：(chapter_id, title, content, summary)
    pub fn list_backups(&self, task_id: i64) -> Result<Vec<(i64, String, String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT chapter_id, title, content, summary FROM chapter_backups
             WHERE task_id = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![task_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn delete_backups(&self, task_id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM chapter_backups WHERE task_id = ?1",
            params![task_id],
        )?;
        Ok(())
    }
}

/// 编辑器存的是 HTML，转成带段落换行的纯文本（统计字数/喂给 LLM/导出都用它）
pub fn html_to_text(s: &str) -> String {
    // 块级标签先转换成换行，再剥掉剩余标签
    let pre = s
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n")
        .replace("</p>", "\n");
    let mut out = String::with_capacity(pre.len());
    let mut in_tag = false;
    for c in pre.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    // 压缩连续空行
    let mut collapsed = decoded;
    while collapsed.contains("\n\n\n") {
        collapsed = collapsed.replace("\n\n\n", "\n\n");
    }
    collapsed.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// v20 迁移：旧六节内置卡刷新为纯文笔五节版；用户卡与新格式卡不动。
    /// 手工搭一个 user_version=19 的最小库（只有 styles 表），重开触发 v20 块
    #[test]
    fn migrates_v20_builtin_styles() {
        let path = std::env::temp_dir().join(format!(
            "novel-studio-test-v20-{}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE styles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    source TEXT NOT NULL DEFAULT '',
                    sample_chars INTEGER NOT NULL DEFAULT 0,
                    guide TEXT NOT NULL DEFAULT '',
                    example TEXT NOT NULL DEFAULT '',
                    kind TEXT NOT NULL DEFAULT 'text',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                PRAGMA user_version = 19;",
            )
            .unwrap();
            for (name, source, guide) in [
                ("古龙风", "内置", "【整体基调】旧六节卡"),
                ("我的风格", "本地文本", "【整体基调】用户蒸馏卡"),
                ("新内置", "内置", "【画面与细节】已是新五节卡"),
            ] {
                conn.execute(
                    "INSERT INTO styles (name, source, guide, created_at, updated_at)
                     VALUES (?1, ?2, ?3, 1, 1)",
                    params![name, source, guide],
                )
                .unwrap();
            }
        }

        let db = Db::new(&path).unwrap(); // 重开 → 跑 v20 迁移
        let get_guide = |name: &str| -> String {
            let conn = db.conn.lock().unwrap();
            conn.query_row(
                "SELECT guide FROM styles WHERE name = ?1",
                params![name],
                |r| r.get(0),
            )
            .unwrap()
        };
        let gulong = get_guide("古龙风");
        assert!(gulong.contains("【画面与细节】"), "内置旧卡应刷新为新五节");
        assert!(!gulong.contains("【整体基调】"));
        assert_eq!(get_guide("我的风格"), "【整体基调】用户蒸馏卡");
        assert_eq!(get_guide("新内置"), "【画面与细节】已是新五节卡");

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }
}
