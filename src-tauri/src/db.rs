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
    pub duration_ms: i64,
    /// pending / imaged / voiced / error
    pub status: String,
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
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct Db {
    conn: Mutex<Connection>,
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
            conn: Mutex::new(conn),
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
            conn.execute_batch(
                "ALTER TABLE chapters ADD COLUMN summary TEXT NOT NULL DEFAULT '';",
            )
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
        Ok(())
    }

    // ---------- 作品 ----------

    pub fn create_project(&self, name: &str, description: &str) -> Result<Project> {
        let conn = self.conn.lock().unwrap();
        let ts = now();
        conn.execute(
            "INSERT INTO projects (name, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![name, description, ts],
        )?;
        Ok(Project {
            id: conn.last_insert_rowid(),
            name: name.to_string(),
            description: description.to_string(),
            synopsis: String::new(),
            created_at: ts,
            updated_at: ts,
        })
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, description, synopsis, created_at, updated_at
             FROM projects ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Project {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                synopsis: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
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
        conn.execute(
            "INSERT INTO chapters (project_id, title, order_index, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![project_id, title, next_index, ts],
        )?;
        Ok(Chapter {
            id: conn.last_insert_rowid(),
            project_id,
            title: title.to_string(),
            content: String::new(),
            summary: String::new(),
            order_index: next_index,
            word_count: 0,
            created_at: ts,
            updated_at: ts,
        })
    }

    pub fn list_chapters(&self, project_id: i64) -> Result<Vec<ChapterMeta>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, title, order_index, word_count, updated_at
             FROM chapters WHERE project_id = ?1 ORDER BY order_index ASC",
        )?;
        let rows = stmt.query_map(params![project_id], |r| {
            Ok(ChapterMeta {
                id: r.get(0)?,
                project_id: r.get(1)?,
                title: r.get(2)?,
                order_index: r.get(3)?,
                word_count: r.get(4)?,
                updated_at: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_chapter(&self, id: i64) -> Result<Chapter> {
        let conn = self.conn.lock().unwrap();
        let chapter = conn.query_row(
            "SELECT id, project_id, title, content, summary, order_index, word_count, created_at, updated_at
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
                    created_at: r.get(7)?,
                    updated_at: r.get(8)?,
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
            "SELECT id, project_id, title, content, summary, order_index, word_count, created_at, updated_at
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
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
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
            "SELECT id, project_id, title, content, order_index, status, created_at, updated_at
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
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
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
            created_at: ts,
            updated_at: ts,
        })
    }

    pub fn save_outline_item(&self, id: i64, title: &str, content: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE outline_items SET title = ?1, content = ?2, updated_at = ?3 WHERE id = ?4",
            params![title, content, now(), id],
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

    /// AI 生成大纲后整表替换
    pub fn replace_outline(&self, project_id: i64, items: &[(String, String)]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM outline_items WHERE project_id = ?1",
            params![project_id],
        )?;
        let ts = now();
        for (i, (title, content)) in items.iter().enumerate() {
            conn.execute(
                "INSERT INTO outline_items (project_id, title, content, order_index, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![project_id, title, content, i as i64 + 1, ts],
            )?;
        }
        Ok(())
    }

    // ---------- 推文视频 ----------

    pub fn create_video(&self, project_id: i64, title: &str, chapter_ids: &str) -> Result<Video> {
        let conn = self.conn.lock().unwrap();
        let ts = now();
        conn.execute(
            "INSERT INTO videos (project_id, title, chapter_ids, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![project_id, title, chapter_ids, ts],
        )?;
        Ok(Video {
            id: conn.last_insert_rowid(),
            project_id,
            title: title.to_string(),
            chapter_ids: chapter_ids.to_string(),
            narration: String::new(),
            status: "draft".to_string(),
            output_path: String::new(),
            error: String::new(),
            created_at: ts,
            updated_at: ts,
        })
    }

    pub fn list_videos(&self, project_id: i64) -> Result<Vec<Video>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, title, chapter_ids, narration, status, output_path, error, created_at, updated_at
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
                output_path: r.get(6)?,
                error: r.get(7)?,
                created_at: r.get(8)?,
                updated_at: r.get(9)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_video(&self, id: i64) -> Result<Video> {
        let conn = self.conn.lock().unwrap();
        let v = conn.query_row(
            "SELECT id, project_id, title, chapter_ids, narration, status, output_path, error, created_at, updated_at
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
                    output_path: r.get(6)?,
                    error: r.get(7)?,
                    created_at: r.get(8)?,
                    updated_at: r.get(9)?,
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
            "SELECT id, video_id, idx, text, prompt, image_path, audio_path, duration_ms, status, created_at, updated_at
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
                duration_ms: r.get(7)?,
                status: r.get(8)?,
                created_at: r.get(9)?,
                updated_at: r.get(10)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_shot(&self, id: i64) -> Result<VideoShot> {
        let conn = self.conn.lock().unwrap();
        let s = conn.query_row(
            "SELECT id, video_id, idx, text, prompt, image_path, audio_path, duration_ms, status, created_at, updated_at
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
                    duration_ms: r.get(7)?,
                    status: r.get(8)?,
                    created_at: r.get(9)?,
                    updated_at: r.get(10)?,
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
