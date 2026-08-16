//! 任务队列：长任务统一入队，单 worker 串行执行。
//!
//! 任务 = tasks 表一行（pending → running → done/error/cancelled）。
//! worker 在应用启动时 spawn，靠 Notify 唤醒；执行器按 kind 分发。
//! 已接入：batch_chapters（批量写章）、video_shots（镜头图生视频）。

use crate::db::{Db, Task};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, State};
use tokio::sync::Notify;

/// 任务执行结果（error 走 Err）
pub enum TaskEnd {
    Done(String),
    Cancelled(String),
}

fn notify() -> &'static Notify {
    static N: OnceLock<Notify> = OnceLock::new();
    N.get_or_init(Notify::new)
}

fn cancel_set() -> &'static Mutex<HashSet<i64>> {
    static S: OnceLock<Mutex<HashSet<i64>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 请求取消（running 任务在下一个检查点停下）
pub fn request_cancel(task_id: i64) {
    cancel_set().lock().unwrap().insert(task_id);
}

/// 执行器在检查点查询
pub fn is_cancel_requested(task_id: i64) -> bool {
    cancel_set().lock().unwrap().contains(&task_id)
}

/// 应用启动时 spawn 唯一 worker（在 lib.rs setup 里调用）
pub fn spawn_worker(app: AppHandle, db: Db) {
    // 启动恢复：上次进程退出时还在 running 的任务标记为中断（可重试）
    {
        let conn = db.clone();
        if let Err(e) = conn.interrupt_running_tasks() {
            eprintln!("恢复中断任务失败: {e}");
        }
    }
    // 必须走 tauri 的 async_runtime：setup 阶段没有 Tokio runtime 上下文，
    // 直接 tokio::spawn 会 panic（there is no reactor running）
    tauri::async_runtime::spawn(async move {
        loop {
            match db.take_next_pending_task() {
                Ok(Some(task)) => {
                    cancel_set().lock().unwrap().remove(&task.id);
                    let end = run_task(&app, &db, &task).await;
                    cancel_set().lock().unwrap().remove(&task.id);
                    let r = match end {
                        Ok(TaskEnd::Done(msg)) => db.finish_task(task.id, "done", &msg, ""),
                        Ok(TaskEnd::Cancelled(msg)) => {
                            db.finish_task(task.id, "cancelled", &msg, "")
                        }
                        Err(e) => db.finish_task(task.id, "error", "", &e),
                    };
                    if let Err(e) = r {
                        eprintln!("任务 {} 收尾写库失败: {e}", task.id);
                    }
                }
                Ok(None) => {
                    notify().notified().await;
                }
                Err(e) => {
                    eprintln!("任务队列轮询失败: {e}");
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
            }
        }
    });
}

async fn run_task(app: &AppHandle, db: &Db, task: &Task) -> Result<TaskEnd, String> {
    match task.kind.as_str() {
        "batch_chapters" => crate::commands::run_batch_chapters(db, task).await,
        "video_shots" => crate::commands_video::run_video_shots(app, db, task).await,
        "rewrite_chapters" => crate::commands::run_rewrite_chapters(db, task).await,
        other => Err(format!("未知任务类型: {other}")),
    }
}

// ---------- 命令 ----------

/// 批量写章入队（同作品已有未完结批量任务时拒绝）
#[tauri::command]
pub fn enqueue_batch_chapters(
    db: State<'_, Db>,
    project_id: i64,
    chapter_count: i64,
    words_per_chapter: i64,
) -> Result<Task, String> {
    if db
        .has_active_task(project_id, "batch_chapters")
        .map_err(|e| e.to_string())?
    {
        return Err("该作品已有批量写章任务在队列中".to_string());
    }
    let project = db
        .list_projects()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or("作品不存在")?;

    // 预估章数/字数/时长（实测一章正文+摘要约 45s）
    let wpc = if words_per_chapter > 0 {
        words_per_chapter
    } else if project.target_chapter_words > 0 {
        project.target_chapter_words
    } else {
        2000
    };
    let (count, total_words) = if chapter_count <= 0 {
        let written = db.total_word_count(project_id).map_err(|e| e.to_string())?;
        let remaining = (project.target_total_words - written).max(0);
        ((remaining + wpc - 1) / wpc, remaining)
    } else {
        (chapter_count, chapter_count * wpc)
    };
    let mins = count * 45 / 60;
    let duration = if mins >= 60 {
        format!("约 {} 小时 {} 分钟", mins / 60, mins % 60)
    } else {
        format!("约 {} 分钟", mins.max(1))
    };
    let wan = format!("{:.1}", total_words as f64 / 10000.0);
    let label = if chapter_count <= 0 {
        format!("《{}》写完整本书（约 {count} 章 · {wan} 万字 · {duration}）", project.name)
    } else {
        format!("《{}》批量写章 ×{count}（约 {wan} 万字 · {duration}）", project.name)
    };
    let payload = serde_json::json!({
        "chapter_count": chapter_count,
        "words_per_chapter": words_per_chapter,
    })
    .to_string();
    let task = db
        .create_task(project_id, "batch_chapters", &label, &payload)
        .map_err(|e| e.to_string())?;
    notify().notify_one();
    Ok(task)
}

/// 镜头图生视频入队
#[tauri::command]
pub fn enqueue_video_shots(db: State<'_, Db>, video_id: i64) -> Result<Task, String> {
    let video = db.get_video(video_id).map_err(|e| e.to_string())?;
    if db
        .has_active_task(video.project_id, "video_shots")
        .map_err(|e| e.to_string())?
    {
        return Err("该作品已有镜头视频任务在队列中".to_string());
    }
    let label = format!("《{}》镜头视频生成", video.title);
    let payload = serde_json::json!({ "video_id": video_id }).to_string();
    let task = db
        .create_task(video.project_id, "video_shots", &label, &payload)
        .map_err(|e| e.to_string())?;
    notify().notify_one();
    Ok(task)
}

/// 跨章改写入队（快照在 worker 里逐章备份，可回滚）
#[tauri::command]
pub fn enqueue_rewrite_chapters(
    db: State<'_, Db>,
    project_id: i64,
    chapter_ids: Vec<i64>,
    instruction: String,
) -> Result<Task, String> {
    if chapter_ids.is_empty() {
        return Err("没有选中要改写的章节".to_string());
    }
    if db
        .has_active_task(project_id, "rewrite_chapters")
        .map_err(|e| e.to_string())?
    {
        return Err("该作品已有跨章改写任务在队列中".to_string());
    }
    let name = db
        .list_projects()
        .ok()
        .and_then(|ps| ps.into_iter().find(|p| p.id == project_id))
        .map(|p| p.name)
        .unwrap_or_default();
    let label = format!("《{}》跨章改写 ×{}", name, chapter_ids.len());
    let payload = serde_json::json!({
        "chapter_ids": chapter_ids,
        "instruction": instruction.trim(),
    })
    .to_string();
    let task = db
        .create_task(project_id, "rewrite_chapters", &label, &payload)
        .map_err(|e| e.to_string())?;
    notify().notify_one();
    Ok(task)
}

#[tauri::command]
pub fn list_tasks(db: State<'_, Db>) -> Result<Vec<Task>, String> {
    db.list_tasks().map_err(|e| e.to_string())
}

/// 取消任务：pending 直接标记，running 置取消标志（执行器在检查点停）
#[tauri::command]
pub fn cancel_task(db: State<'_, Db>, id: i64) -> Result<(), String> {
    let t = db.get_task(id).map_err(|e| e.to_string())?;
    match t.status.as_str() {
        "pending" => db
            .finish_task(id, "cancelled", "", "已取消")
            .map_err(|e| e.to_string())?,
        "running" => request_cancel(id),
        _ => {}
    }
    Ok(())
}

/// 失败/取消的任务按原参数重新入队
#[tauri::command]
pub fn retry_task(db: State<'_, Db>, id: i64) -> Result<Task, String> {
    let t = db.get_task(id).map_err(|e| e.to_string())?;
    if t.status == "pending" || t.status == "running" {
        return Err("任务还在进行中".to_string());
    }
    if db
        .has_active_task(t.project_id, &t.kind)
        .map_err(|e| e.to_string())?
    {
        return Err("已有同类任务在队列中".to_string());
    }
    // 批量写章按已完成进度扣减：写 10 章在第 3 章失败，重试只补剩余 8 章
    //（progress_current 在失败时停在上次推进的位置；"写完整本书"类 count<=0 每次重算，无需调整）
    let mut payload = t.payload.clone();
    if t.kind == "batch_chapters" && t.progress_current > 0 {
        if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&t.payload) {
            let orig = v["chapter_count"].as_i64().unwrap_or(0);
            if orig > 0 {
                let remaining = (orig - t.progress_current).max(1);
                v["chapter_count"] = serde_json::json!(remaining);
                payload = v.to_string();
            }
        }
    }
    let nt = db
        .create_task(t.project_id, &t.kind, &t.label, &payload)
        .map_err(|e| e.to_string())?;
    notify().notify_one();
    Ok(nt)
}

#[tauri::command]
pub fn clear_finished_tasks(db: State<'_, Db>) -> Result<(), String> {
    db.clear_finished_tasks().map_err(|e| e.to_string())
}
