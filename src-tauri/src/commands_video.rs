//! 推文视频流水线命令：口播稿 → 分镜 → 逐镜生图 → 配音 → 合成
//!
//! 关键决策（docs/prd.md v0.4）：
//! - 每一步产物落库/落盘，可单步重跑：一镜画崩只重画该镜
//! - 口播稿/分镜都走设定注入（架构红线 2）
//! - 第一刀镜头为"静图 + 运镜"，图生视频 API 后续切片

use crate::commands::{build_lore_section, load_image_config, load_llm_config, ProgressEvent};
use crate::db::{Db, Task, Video, VideoShot};
use crate::image_gen;
use crate::llm::{self, StreamEvent};
use crate::tasks::TaskEnd;
use crate::video::{self, ComposeShot, TtsConfig};
use crate::video_gen::{self, VideoGenConfig};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use base64::Engine;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// 分镜生图尺寸：9:16 竖屏（抖音/TikTok 比例）。
/// 注意：生图 API 对 size 的合法值各家不同，若火山方舟报错按实际模型文档调整
const SHOT_SIZE: &str = "1080x1920";

#[derive(Serialize)]
pub struct VideoDetail {
    video: Video,
    shots: Vec<VideoShot>,
}

fn videos_dir(app: &AppHandle, video: &Video) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("videos")
        .join(video.project_id.to_string())
        .join(video.id.to_string());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn load_tts_config(db: &Db) -> TtsConfig {
    let read = |key: &str, default: &str| {
        db.get_setting(key)
            .ok()
            .flatten()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| default.to_string())
    };
    TtsConfig {
        app_id: read("tts_app_id", ""),
        access_token: read("tts_access_token", ""),
        cluster: read("tts_cluster", "volcano_tts"),
        // 音色按火山控制台实际开通的填，此处只是默认值
        voice: read("tts_voice", "zh_female_cancan_mars_bigtts"),
    }
}

// ---------- 视频任务 ----------

#[tauri::command]
pub fn create_video(
    db: State<'_, Db>,
    project_id: i64,
    title: String,
    chapter_ids: Vec<i64>,
    mode: Option<String>,
) -> Result<Video, String> {
    if chapter_ids.is_empty() {
        return Err("请先选择取材章节".to_string());
    }
    let mode = mode.unwrap_or_else(|| "image".to_string());
    if mode != "image" && mode != "video" {
        return Err(format!("未知的视频模式: {mode}"));
    }
    let ids = chapter_ids
        .iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(",");
    db.create_video(project_id, &title, &ids, &mode)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_videos(db: State<'_, Db>, project_id: i64) -> Result<Vec<Video>, String> {
    db.list_videos(project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_video_detail(db: State<'_, Db>, video_id: i64) -> Result<VideoDetail, String> {
    let video = db.get_video(video_id).map_err(|e| e.to_string())?;
    let shots = db.list_shots(video_id).map_err(|e| e.to_string())?;
    Ok(VideoDetail { video, shots })
}

#[tauri::command]
pub fn delete_video(app: AppHandle, db: State<'_, Db>, video_id: i64) -> Result<(), String> {
    let video = db.get_video(video_id).map_err(|e| e.to_string())?;
    db.delete_video(video_id).map_err(|e| e.to_string())?;
    // 产物目录一并清掉
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("videos")
        .join(video.project_id.to_string())
        .join(video.id.to_string());
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
}

#[tauri::command]
pub fn save_narration(db: State<'_, Db>, video_id: i64, narration: String) -> Result<(), String> {
    db.save_narration(video_id, &narration)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_shot_prompt(
    db: State<'_, Db>,
    shot_id: i64,
    prompt: String,
) -> Result<(), String> {
    db.update_shot_prompt(shot_id, &prompt)
        .map_err(|e| e.to_string())
}

// ---------- 第一步：口播稿（流式，设定注入） ----------

const NARRATION_SYSTEM: &str = "你是短视频小说推文编导，擅长把小说章节改写成 60~90 秒的口播推文稿。\
要求：开场 3 秒必须有钩子（悬念/冲突/反转）；口语化、短句为主；结尾留悬念引导关注；\
严格遵守给定的人物与世界观设定，不编造设定外的情节。\
直接输出口播稿正文，不要分镜标注、不要解释。";

#[tauri::command]
pub async fn generate_narration(
    db: State<'_, Db>,
    video_id: i64,
    channel: Channel<StreamEvent>,
) -> Result<(), String> {
    let video = db.get_video(video_id).map_err(|e| e.to_string())?;

    // 取材章节内容（长章取头 2500 + 尾 1500，成本可控）
    let mut source = String::new();
    for id in video.chapter_ids.split(',').filter(|s| !s.is_empty()) {
        let id: i64 = id.parse().map_err(|_| "章节 ID 解析失败".to_string())?;
        let ch = db.get_chapter(id).map_err(|e| e.to_string())?;
        let plain = crate::db::html_to_text(&ch.content);
        let total = plain.chars().count();
        let excerpt = if total > 4000 {
            let head: String = plain.chars().take(2500).collect();
            let tail: String = plain
                .chars()
                .skip(total - 1500)
                .collect();
            format!("{head}\n……（中段略）……\n{tail}")
        } else {
            plain
        };
        source.push_str(&format!("《{}》\n{}\n\n", ch.title, excerpt));
    }
    if source.trim().is_empty() {
        return Err("取材章节还没有内容".to_string());
    }

    // 设定注入（红线：任何 AI 输出都过设定库）
    let entries = db
        .list_lore_entries(video.project_id)
        .unwrap_or_default();
    let (lore_section, injected) = build_lore_section(&entries, &source);
    let _ = channel.send(StreamEvent::Meta {
        note: if injected.is_empty() {
            "未注入设定".to_string()
        } else {
            format!("已注入设定：{}", injected.join("、"))
        },
    });

    let lore_block = if lore_section.is_empty() {
        String::new()
    } else {
        format!("【设定资料】（必须严格遵守）\n{lore_section}\n\n")
    };
    let user = format!(
        "{lore_block}【小说原文】\n{}\n\n【任务】\n把以上内容改写成一条 250~350 字的推文口播稿。",
        source.trim()
    );

    let cfg = load_llm_config(&db);
    llm::stream_chat(
        cfg,
        vec![
            ("system".to_string(), NARRATION_SYSTEM.to_string()),
            ("user".to_string(), user),
        ],
        channel,
    )
    .await
    .map_err(|e| e.to_string())
}

// ---------- 第二步：分镜（结构化 JSON） ----------

#[derive(Deserialize)]
struct ShotDraft {
    text: String,
    prompt: String,
}

const STORYBOARD_SYSTEM: &str = "你是短视频分镜师。把口播稿切成 8~14 个镜头，每镜一句口播。\
为每镜写画面提示词（用于 AI 生图）：\
1）画面描述具体（人物动作、表情、环境、光线、镜头感）；\
2）出场的每个角色必须带上设定资料里的外貌关键词，保证跨镜一致；\
3）结尾统一加风格后缀「古风玄幻插画，电影感打光，竖版构图，无文字」；\
4）画面中绝不出现文字。\
只输出 JSON 数组，格式：[{\"text\": \"口播句\", \"prompt\": \"画面提示词\"}…]，不要输出其他内容。";

#[tauri::command]
pub async fn generate_storyboard(
    db: State<'_, Db>,
    video_id: i64,
) -> Result<VideoDetail, String> {
    let video = db.get_video(video_id).map_err(|e| e.to_string())?;
    if video.narration.trim().is_empty() {
        return Err("请先生成（或填写）口播稿".to_string());
    }

    // 人物设定注入，让提示词带上角色外貌
    let entries = db
        .list_lore_entries(video.project_id)
        .unwrap_or_default();
    let (lore_section, _) = build_lore_section(&entries, &video.narration);
    let lore_block = if lore_section.is_empty() {
        String::new()
    } else {
        format!("【设定资料】\n{lore_section}\n\n")
    };

    let cfg = load_llm_config(&db);
    let raw = llm::chat_once(
        cfg,
        vec![
            ("system".to_string(), STORYBOARD_SYSTEM.to_string()),
            (
                "user".to_string(),
                format!("{lore_block}【口播稿】\n{}", video.narration.trim()),
            ),
        ],
    )
    .await
    .map_err(|e| e.to_string())?;

    // 宽容解析：截取首个 [ 到末个 ]
    let start = raw.find('[').ok_or("分镜结果不是 JSON 数组")?;
    let end = raw.rfind(']').ok_or("分镜结果不是 JSON 数组")?;
    let drafts: Vec<ShotDraft> = serde_json::from_str(&raw[start..=end])
        .map_err(|e| format!("分镜 JSON 解析失败: {e}"))?;
    let pairs: Vec<(String, String)> = drafts
        .into_iter()
        .map(|d| (d.text.trim().to_string(), d.prompt.trim().to_string()))
        .filter(|(t, p)| !t.is_empty() && !p.is_empty())
        .collect();
    if pairs.is_empty() {
        return Err("分镜结果为空，请重试".to_string());
    }

    db.replace_shots(video_id, &pairs)
        .map_err(|e| e.to_string())?;
    get_video_detail(db, video_id)
}

// ---------- 第三步：逐镜生图（可单镜重绘） ----------

async fn gen_one_image(app: &AppHandle, db: &Db, shot: &VideoShot) -> Result<String, String> {
    let video = db.get_video(shot.video_id).map_err(|e| e.to_string())?;
    let cfg = load_image_config(db);

    // 角色一致性：命中词条（常驻/关键词/标题命中本镜文本）且配有参考图时，随生图请求带上
    let entries = db
        .list_lore_entries(video.project_id)
        .unwrap_or_default();
    let context = format!("{}\n{}", shot.text, shot.prompt);
    let mut refs: Vec<String> = Vec::new();
    for e in entries
        .iter()
        .filter(|e| e.enabled && !e.ref_image.is_empty())
    {
        let keyword_hit = e
            .keywords
            .split([',', '，'])
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .any(|k| context.contains(k));
        if !(e.always_include || keyword_hit || context.contains(&e.title)) {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&e.ref_image) {
            refs.push(format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ));
        }
        if refs.len() >= 3 {
            break; // 参考图最多带 3 张，防止 prompt 过载
        }
    }

    let bytes = image_gen::generate_image(&cfg, &shot.prompt, SHOT_SIZE, &refs)
        .await
        .map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = videos_dir(app, &video)?.join(format!("shot-{}-{ts}.png", shot.id));
    std::fs::write(&path, &bytes).map_err(|e| format!("保存镜头图失败: {e}"))?;
    let path_str = path.to_string_lossy().to_string();
    db.set_shot_image(shot.id, &path_str)
        .map_err(|e| e.to_string())?;
    Ok(path_str)
}

/// 单镜生图/重绘
#[tauri::command]
pub async fn generate_shot_image(
    app: AppHandle,
    db: State<'_, Db>,
    shot_id: i64,
) -> Result<String, String> {
    let shot = db.get_shot(shot_id).map_err(|e| e.to_string())?;
    gen_one_image(&app, &db, &shot).await
}

/// 补齐缺图镜头（进度事件）
#[tauri::command]
pub async fn generate_missing_images(
    app: AppHandle,
    db: State<'_, Db>,
    video_id: i64,
    channel: Channel<ProgressEvent>,
) -> Result<(), String> {
    let shots: Vec<VideoShot> = db
        .list_shots(video_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|s| s.image_path.is_empty())
        .collect();
    let total = shots.len() as i64;
    if total == 0 {
        let _ = channel.send(ProgressEvent::Done);
        return Ok(());
    }
    db.set_video_status(video_id, "imaging", "").ok();
    for (i, shot) in shots.iter().enumerate() {
        let _ = channel.send(ProgressEvent::Progress {
            current: i as i64,
            total,
            label: format!("镜头 {}", shot.idx),
        });
        if let Err(e) = gen_one_image(&app, &db, shot).await {
            let msg = format!("镜头 {} 生图失败: {e}", shot.idx);
            db.set_video_status(video_id, "error", &msg).ok();
            let _ = channel.send(ProgressEvent::Error { message: msg });
            return Ok(());
        }
    }
    db.set_video_status(video_id, "imaged", "").ok();
    let _ = channel.send(ProgressEvent::Done);
    Ok(())
}

// ---------- 第三步半：镜头图生视频（Seedance，按量计费；仅 mode=video 的任务用） ----------

fn load_video_gen_config(db: &Db) -> VideoGenConfig {
    let read = |key: &str, default: &str| {
        db.get_setting(key)
            .ok()
            .flatten()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| default.to_string())
    };
    VideoGenConfig {
        base_url: read("img_base_url", "https://ark.cn-beijing.volces.com/api/v3"),
        api_key: read("img_api_key", ""),
        model: read("video_model", "doubao-seedance-1-0-pro-250528"),
    }
}

async fn gen_one_shot_video(
    app: &AppHandle,
    db: &Db,
    cfg: &VideoGenConfig,
    shot: &VideoShot,
) -> Result<(), String> {
    if shot.image_path.is_empty() {
        return Err(format!("镜头 {} 还没有配图，先生成镜头图", shot.idx));
    }
    let video = db.get_video(shot.video_id).map_err(|e| e.to_string())?;
    let out = videos_dir(app, &video)?.join(format!("shot-{}.mp4", shot.id));
    video_gen::generate_from_first_frame(
        cfg,
        &shot.prompt,
        &std::path::PathBuf::from(&shot.image_path),
        &out,
    )
    .await
    .map_err(|e| e.to_string())?;
    db.set_shot_video(shot.id, &out.to_string_lossy().to_string())
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 单镜重跑视频（直接执行；一镜约 1~2 分钟）
#[tauri::command]
pub async fn generate_shot_video(
    app: AppHandle,
    db: State<'_, Db>,
    shot_id: i64,
) -> Result<(), String> {
    let shot = db.get_shot(shot_id).map_err(|e| e.to_string())?;
    let cfg = load_video_gen_config(&db);
    gen_one_shot_video(&app, &db, &cfg, &shot).await
}

/// 镜头视频批量生成执行器（任务队列 kind = video_shots）
pub(crate) async fn run_video_shots(
    app: &AppHandle,
    db: &Db,
    task: &Task,
) -> Result<TaskEnd, String> {
    #[derive(Deserialize)]
    struct Payload {
        video_id: i64,
    }
    let payload: Payload = serde_json::from_str(&task.payload)
        .map_err(|e| format!("任务参数解析失败: {e}"))?;

    let video = db.get_video(payload.video_id).map_err(|e| e.to_string())?;
    let pending: Vec<VideoShot> = db
        .list_shots(video.id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|s| !s.image_path.is_empty() && s.video_path.is_empty())
        .collect();
    if pending.is_empty() {
        return Ok(TaskEnd::Done("所有镜头已有视频".to_string()));
    }
    let total = pending.len() as i64;
    let cfg = load_video_gen_config(db);
    db.set_video_status(video.id, "videoing", "").ok();

    let mut done = 0i64;
    for shot in &pending {
        if crate::tasks::is_cancel_requested(task.id) {
            return Ok(TaskEnd::Cancelled(format!(
                "镜头视频 ×{done}/{total}（已取消，已生成的保留）"
            )));
        }
        let _ = db.update_task_progress(task.id, done, total, &format!("镜头 {}", shot.idx));
        if let Err(e) = gen_one_shot_video(app, db, &cfg, shot).await {
            let msg = format!("镜头 {} 视频生成失败: {e}", shot.idx);
            db.set_video_status(video.id, "error", &msg).ok();
            return Err(format!("{msg}（已生成 {done} 镜，重试会跳过已完成镜头）"));
        }
        done += 1;
    }
    db.set_video_status(video.id, "videoed", "").ok();
    Ok(TaskEnd::Done(format!("镜头视频 ×{done}")))
}

// ---------- 第四步：配音 ----------

async fn synth_one_voice(
    app: &AppHandle,
    db: &Db,
    cfg: &TtsConfig,
    shot: &VideoShot,
) -> Result<(), String> {
    let video = db.get_video(shot.video_id).map_err(|e| e.to_string())?;
    let mp3 = video::tts_synthesize(cfg, &shot.text)
        .await
        .map_err(|e| e.to_string())?;
    let path = videos_dir(app, &video)?.join(format!("shot-{}.mp3", shot.id));
    std::fs::write(&path, &mp3).map_err(|e| format!("保存配音失败: {e}"))?;
    let duration = video::probe_duration_ms(&path).map_err(|e| e.to_string())?;
    db.set_shot_audio(shot.id, &path.to_string_lossy().to_string(), duration)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn synthesize_voices(
    app: AppHandle,
    db: State<'_, Db>,
    video_id: i64,
    channel: Channel<ProgressEvent>,
) -> Result<(), String> {
    let shots: Vec<VideoShot> = db
        .list_shots(video_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|s| s.audio_path.is_empty())
        .collect();
    let total = shots.len() as i64;
    if total == 0 {
        let _ = channel.send(ProgressEvent::Done);
        return Ok(());
    }
    let cfg = load_tts_config(&db);
    db.set_video_status(video_id, "voicing", "").ok();
    for (i, shot) in shots.iter().enumerate() {
        let _ = channel.send(ProgressEvent::Progress {
            current: i as i64,
            total,
            label: format!("镜头 {}", shot.idx),
        });
        if let Err(e) = synth_one_voice(&app, &db, &cfg, shot).await {
            let msg = format!("镜头 {} 配音失败: {e}", shot.idx);
            db.set_video_status(video_id, "error", &msg).ok();
            let _ = channel.send(ProgressEvent::Error { message: msg });
            return Ok(());
        }
    }
    db.set_video_status(video_id, "voiced", "").ok();
    let _ = channel.send(ProgressEvent::Done);
    Ok(())
}

// ---------- 第五步：合成 ----------

#[tauri::command]
pub async fn compose_video(
    app: AppHandle,
    db: State<'_, Db>,
    video_id: i64,
    channel: Channel<ProgressEvent>,
) -> Result<VideoDetail, String> {
    let video = db.get_video(video_id).map_err(|e| e.to_string())?;
    let shots = db.list_shots(video_id).map_err(|e| e.to_string())?;
    if shots.is_empty() {
        return Err("还没有分镜，请先生成分镜".to_string());
    }
    for s in &shots {
        if s.image_path.is_empty() {
            return Err(format!("镜头 {} 还没有配图", s.idx));
        }
        if s.audio_path.is_empty() {
            return Err(format!("镜头 {} 还没有配音", s.idx));
        }
    }

    db.set_video_status(video_id, "composing", "").ok();
    let _ = channel.send(ProgressEvent::Progress {
        current: 0,
        total: 2,
        label: "合成镜头与音轨".to_string(),
    });

    let dir = videos_dir(&app, &video)?;
    let out = dir.join("final.mp4");
    let compose_shots: Vec<ComposeShot> = shots
        .iter()
        .map(|s| ComposeShot {
            image: PathBuf::from(&s.image_path),
            audio: PathBuf::from(&s.audio_path),
            video: if s.video_path.is_empty() {
                None
            } else {
                Some(PathBuf::from(&s.video_path))
            },
            duration_ms: s.duration_ms,
            text: s.text.clone(),
        })
        .collect();

    // 合成是 CPU 密集活，扔到阻塞线程
    let dir_clone = dir.clone();
    let out_clone = out.clone();
    let result = tokio::task::spawn_blocking(move || {
        video::compose(&dir_clone, &compose_shots, &out_clone)
    })
    .await
    .map_err(|e| e.to_string())?;

    match result {
        Ok(()) => {
            let _ = channel.send(ProgressEvent::Progress {
                current: 2,
                total: 2,
                label: "完成".to_string(),
            });
            let _ = channel.send(ProgressEvent::Done);
            db.set_video_output(video_id, &out.to_string_lossy().to_string())
                .map_err(|e| e.to_string())?;
            get_video_detail(db, video_id)
        }
        Err(e) => {
            let msg = format!("合成失败: {e}");
            db.set_video_status(video_id, "error", &msg).ok();
            let _ = channel.send(ProgressEvent::Error {
                message: msg.clone(),
            });
            Err(msg)
        }
    }
}

/// 在系统文件管理器中打开视频产物目录
#[tauri::command]
pub fn open_video_folder(app: AppHandle, db: State<'_, Db>, video_id: i64) -> Result<(), String> {
    let video = db.get_video(video_id).map_err(|e| e.to_string())?;
    let dir = videos_dir(&app, &video)?;
    std::process::Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("打开文件夹失败: {e}"))?;
    Ok(())
}
