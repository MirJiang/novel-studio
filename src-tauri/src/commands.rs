//! Tauri 命令：前端 invoke 的全部入口

use crate::db::{self, Chapter, ChapterMeta, Db, LoreEntry, OutlineItem, Project};
use crate::image_gen::{self, ImageConfig};
use crate::llm::{self, LlmConfig, StreamEvent};
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// 批量任务的进度事件（如批量生成摘要）
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProgressEvent {
    Progress { current: i64, total: i64, label: String },
    Done,
    Error { message: String },
}

// ---------- 作品 ----------

#[tauri::command]
pub fn create_project(
    db: State<'_, Db>,
    name: String,
    description: Option<String>,
) -> Result<Project, String> {
    db.create_project(&name, description.as_deref().unwrap_or(""))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_projects(db: State<'_, Db>) -> Result<Vec<Project>, String> {
    db.list_projects().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_project(db: State<'_, Db>, id: i64, name: String) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("名称不能为空".to_string());
    }
    db.rename_project(id, name).map_err(|e| e.to_string())
}

/// 删除作品：DB 级联删章节/设定/报告/视频，磁盘清封面与视频目录
#[tauri::command]
pub fn delete_project(app: AppHandle, db: State<'_, Db>, id: i64) -> Result<(), String> {
    db.delete_project(id).map_err(|e| e.to_string())?;
    if let Ok(base) = app.path().app_data_dir() {
        let _ = std::fs::remove_dir_all(base.join("covers").join(id.to_string()));
        let _ = std::fs::remove_dir_all(base.join("videos").join(id.to_string()));
    }
    Ok(())
}

/// 保存作品信息（题材标签 + 长简介）
#[tauri::command]
pub fn save_project_info(
    db: State<'_, Db>,
    id: i64,
    description: String,
    synopsis: String,
) -> Result<(), String> {
    db.save_project_info(id, &description, &synopsis)
        .map_err(|e| e.to_string())
}

/// AI 生成番茄风简介：从题材标签 + 设定库 + 首章开头提炼卖点
#[tauri::command]
pub async fn generate_synopsis(db: State<'_, Db>, project_id: i64) -> Result<String, String> {
    let cfg = load_llm_config(&db);
    let entries = db.list_lore_entries(project_id).unwrap_or_default();
    let lore: String = entries
        .iter()
        .filter(|e| e.enabled)
        .map(|e| format!("◆ {}（{}）{}", e.title, e.category, e.content.trim()))
        .collect::<Vec<_>>()
        .join("\n");
    let lore = head_chars(&lore, 1500);

    // 首章开头 800 字当氛围参考（可能没有）
    let first_chapter = db
        .list_chapter_bodies(project_id)
        .ok()
        .and_then(|b| b.into_iter().next())
        .map(|(_, c)| head_chars(&crate::db::html_to_text(&c), 800))
        .unwrap_or_default();

    let text = llm::chat_once(
        cfg,
        vec![
            (
                "system".to_string(),
                "你是网文平台金牌编辑，专门写番茄小说风格的作品简介。\
                要求：100~150 字；第一句就是钩子（反常/悬念/冲突）；点出主角的金手指或最大看点；\
                结尾抛悬念或反转预告；短句、有节奏感、绝不平淡复述剧情。\
                只输出简介正文，不要书名、不要解释。"
                    .to_string(),
            ),
            (
                "user".to_string(),
                format!(
                    "【设定资料】\n{}\n\n【首章氛围】\n{}",
                    if lore.is_empty() { "（暂无）" } else { &lore },
                    if first_chapter.is_empty() {
                        "（暂无正文）"
                    } else {
                        &first_chapter
                    }
                ),
            ),
        ],
    )
    .await
    .map_err(|e| e.to_string())?;

    let project = db
        .list_projects()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or("作品不存在")?;
    db.save_project_info(project_id, &project.description, &text)
        .map_err(|e| e.to_string())?;
    Ok(text)
}

/// 上传人物卡参考图：复制到应用数据目录并记录路径，返回存储路径
#[tauri::command]
pub fn set_lore_ref_image(
    app: AppHandle,
    db: State<'_, Db>,
    entry_id: i64,
    src_path: String,
) -> Result<String, String> {
    let ext = std::path::Path::new(&src_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_string();
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("lore_refs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("entry-{entry_id}.{ext}"));
    std::fs::copy(&src_path, &dest).map_err(|e| format!("复制参考图失败: {e}"))?;
    let dest_str = dest.to_string_lossy().to_string();
    db.set_lore_ref_image(entry_id, &dest_str)
        .map_err(|e| e.to_string())?;
    Ok(dest_str)
}

/// 移除人物卡参考图
#[tauri::command]
pub fn remove_lore_ref_image(db: State<'_, Db>, entry_id: i64) -> Result<(), String> {
    db.set_lore_ref_image(entry_id, "")
        .map_err(|e| e.to_string())
}

// ---------- 章节 ----------

#[tauri::command]
pub fn create_chapter(
    db: State<'_, Db>,
    project_id: i64,
    title: String,
) -> Result<Chapter, String> {
    db.create_chapter(project_id, &title)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_chapters(db: State<'_, Db>, project_id: i64) -> Result<Vec<ChapterMeta>, String> {
    db.list_chapters(project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_chapter(db: State<'_, Db>, id: i64) -> Result<Chapter, String> {
    db.get_chapter(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_chapter(
    db: State<'_, Db>,
    id: i64,
    title: String,
    content: String,
) -> Result<(), String> {
    db.save_chapter(id, &title, &content)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_chapter(db: State<'_, Db>, id: i64) -> Result<(), String> {
    db.delete_chapter(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_summary(db: State<'_, Db>, id: i64, summary: String) -> Result<(), String> {
    db.save_summary(id, &summary).map_err(|e| e.to_string())
}

// ---------- 设定库 ----------

#[tauri::command]
pub fn create_lore_entry(
    db: State<'_, Db>,
    project_id: i64,
    title: String,
    category: String,
) -> Result<LoreEntry, String> {
    db.create_lore_entry(project_id, &title, &category)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_lore_entries(db: State<'_, Db>, project_id: i64) -> Result<Vec<LoreEntry>, String> {
    db.list_lore_entries(project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_lore_entry(db: State<'_, Db>, entry: LoreEntry) -> Result<(), String> {
    db.update_lore_entry(&entry).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_lore_entry(db: State<'_, Db>, id: i64) -> Result<(), String> {
    db.delete_lore_entry(id).map_err(|e| e.to_string())
}

// ---------- 设置 ----------

#[tauri::command]
pub fn get_setting(db: State<'_, Db>, key: String) -> Result<Option<String>, String> {
    db.get_setting(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_setting(db: State<'_, Db>, key: String, value: String) -> Result<(), String> {
    db.set_setting(&key, &value).map_err(|e| e.to_string())
}

// ---------- 导出 ----------

#[tauri::command]
pub fn export_project(
    db: State<'_, Db>,
    project_id: i64,
    path: String,
) -> Result<String, String> {
    let bodies = db
        .list_chapter_bodies(project_id)
        .map_err(|e| e.to_string())?;
    if bodies.is_empty() {
        return Err("当前作品还没有章节".to_string());
    }
    let mut text = String::new();
    for (title, content_html) in &bodies {
        text.push_str(title);
        text.push_str("\n\n");
        text.push_str(&db::html_to_text(content_html));
        text.push_str("\n\n\n");
    }
    std::fs::write(&path, text).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(path)
}

// ---------- 封面 ----------

#[derive(Serialize)]
pub struct CoverResult {
    path: String,
    data_url: String,
}

pub(crate) fn load_image_config(db: &Db) -> ImageConfig {
    let read = |key: &str, default: &str| {
        db.get_setting(key)
            .ok()
            .flatten()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| default.to_string())
    };
    ImageConfig {
        base_url: read("img_base_url", "https://ark.cn-beijing.volces.com/api/v3"),
        api_key: read("img_api_key", ""),
        model: read("img_model", "doubao-seedream-4-0-250828"),
    }
}

fn covers_dir(app: &AppHandle, project_id: i64) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("covers")
        .join(project_id.to_string());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 生成封面：AI 出底图 → 程序排版书名/作者 → 存盘并返回预览
#[tauri::command]
pub async fn generate_cover(
    app: AppHandle,
    db: State<'_, Db>,
    project_id: i64,
    prompt: String,
    title: String,
    author: String,
) -> Result<CoverResult, String> {
    if prompt.trim().is_empty() {
        return Err("请先填写封面画面描述".to_string());
    }
    let cfg = load_image_config(&db);
    let raw = image_gen::generate_image(&cfg, &prompt, image_gen::COVER_SIZE, &[])
        .await
        .map_err(|e| e.to_string())?;
    let composed = image_gen::compose_cover(&raw, &title, &author).map_err(|e| e.to_string())?;

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = covers_dir(&app, project_id)?.join(format!("cover-{ts}.png"));
    std::fs::write(&path, &composed).map_err(|e| format!("保存封面失败: {e}"))?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&composed);
    Ok(CoverResult {
        path: path.to_string_lossy().to_string(),
        data_url: format!("data:image/png;base64,{b64}"),
    })
}

/// 封面历史（新→旧）
#[tauri::command]
pub fn list_covers(app: AppHandle, project_id: i64) -> Result<Vec<String>, String> {
    let dir = covers_dir(&app, project_id)?;
    let mut files: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "png"))
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    files.sort();
    files.reverse(); // 文件名带时间戳，字典序即时间序
    Ok(files)
}

/// 读取封面文件为 data URL（供前端预览）
#[tauri::command]
pub fn get_cover_data(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("读取封面失败: {e}"))?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

// ---------- AI ----------

/// 带给前文的最多字符数
const CONTEXT_TAIL_CHARS: usize = 3000;

/// 设定注入的字符预算，防止 prompt 膨胀
const MAX_LORE_CHARS: usize = 2000;

/// 前情摘要注入的字符预算
const MAX_SUMMARY_CHARS: usize = 1500;

const SYSTEM_PROMPT: &str = "你是一位经验丰富的网络小说作家，擅长中文网文创作。\
根据给定的前文继续写作，保持文风、叙事视角、人称与设定一致。\
直接输出正文内容，不要输出章节标题、解释或任何元信息。";

const TRANSFORM_SYSTEM_PROMPT: &str = "你是一位经验丰富的网络小说编辑，擅长中文网文。\
按用户要求处理给定段落，保持文风、叙事视角、人称与设定一致。\
直接输出处理后的正文，不要输出解释或任何元信息。";

pub(crate) fn load_llm_config(db: &Db) -> LlmConfig {
    let read = |key: &str, default: &str| {
        db.get_setting(key)
            .ok()
            .flatten()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| default.to_string())
    };
    LlmConfig {
        base_url: read("llm_base_url", "https://api.deepseek.com/v1"),
        api_key: read("llm_api_key", ""),
        model: read("llm_model", "deepseek-chat"),
    }
}

fn tail_chars(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let start = chars.len().saturating_sub(max);
    chars[start..].iter().collect()
}

/// 命中规则：常驻注入，或任一关键词出现在上下文中。
/// 返回 (设定文本, 注入的条目标题)
pub(crate) fn build_lore_section(entries: &[LoreEntry], context_text: &str) -> (String, Vec<String>) {
    let mut section = String::new();
    let mut titles = Vec::new();
    for e in entries.iter().filter(|e| e.enabled) {
        let hit = e.always_include
            || e
                .keywords
                .split([',', '，'])
                .map(str::trim)
                .filter(|k| !k.is_empty())
                .any(|k| context_text.contains(k));
        if !hit {
            continue;
        }
        let block = format!(
            "◆ {}（{}）\n{}\n\n",
            e.title,
            e.category,
            e.content.trim()
        );
        if section.len() + block.len() > MAX_LORE_CHARS {
            break; // 超预算就截断，保证 prompt 可控
        }
        section.push_str(&block);
        titles.push(e.title.clone());
    }
    (section, titles)
}

/// 前情摘要区块：当前章节之前所有章的摘要，超预算时优先保留近期的
fn build_summary_section(summaries: &[(String, String)]) -> String {
    let mut picked: Vec<String> = Vec::new();
    let mut total = 0usize;
    for (title, summary) in summaries.iter().rev() {
        let line = format!("《{title}》{}", summary.trim());
        if total + line.len() > MAX_SUMMARY_CHARS && !picked.is_empty() {
            break;
        }
        total += line.len();
        picked.push(line);
    }
    picked.reverse();
    picked.join("\n")
}

/// 大纲注入的字符预算
const MAX_OUTLINE_CHARS: usize = 600;

/// 全书大纲区块：节点名 + 状态，首个未完成节点标记为当前进度
fn build_outline_section(items: &[OutlineItem]) -> String {
    if items.is_empty() {
        return String::new();
    }
    let first_planned = items.iter().position(|i| i.status != "done");
    let mut out = String::new();
    for (i, item) in items.iter().enumerate() {
        let mark = if Some(i) == first_planned {
            " ◀当前"
        } else if item.status == "done" {
            "【已完成】"
        } else {
            ""
        };
        let line = format!("{}. {}{}\n", i + 1, item.title, mark);
        if out.len() + line.len() > MAX_OUTLINE_CHARS {
            out.push_str("……（后续节点略）\n");
            break;
        }
        out.push_str(&line);
    }
    out
}

/// AI 续写
#[tauri::command]
pub async fn ai_continue(
    db: State<'_, Db>,
    chapter_id: i64,
    instruction: Option<String>,
    channel: Channel<StreamEvent>,
) -> Result<(), String> {
    let chapter = db.get_chapter(chapter_id).map_err(|e| e.to_string())?;
    let cfg = load_llm_config(&db);

    let plain = db::html_to_text(&chapter.content);
    let context_tail = tail_chars(&plain, CONTEXT_TAIL_CHARS);

    // 设定库注入：常驻词条 + 关键词命中词条
    let entries = db
        .list_lore_entries(chapter.project_id)
        .unwrap_or_default();
    let (lore_section, injected) = build_lore_section(&entries, &context_tail);

    // 前情摘要注入：当前章之前所有章的摘要
    let summaries = db
        .list_summaries_before(chapter.project_id, chapter.order_index)
        .unwrap_or_default();
    let summary_section = build_summary_section(&summaries);

    // 大纲注入：全书节点 + 当前进度标记（管控整本书的走向）
    let outline = db.list_outline(chapter.project_id).unwrap_or_default();
    let outline_section = build_outline_section(&outline);

    // 把注入明细告知前端（可观测性：崩了能分清是没写设定还是没注入）
    let mut notes = Vec::new();
    notes.push(if injected.is_empty() {
        "未注入设定".to_string()
    } else {
        format!("已注入设定：{}", injected.join("、"))
    });
    if !summaries.is_empty() {
        notes.push(format!("前情摘要 {} 章", summaries.len()));
    } else if chapter.order_index > 1 {
        notes.push("前情摘要缺失（可在章节里点「生成摘要」）".to_string());
    }
    if !outline.is_empty() {
        notes.push(format!("大纲 {} 节", outline.len()));
    }
    let _ = channel.send(StreamEvent::Meta {
        note: notes.join("｜"),
    });

    let system = if lore_section.is_empty() {
        SYSTEM_PROMPT.to_string()
    } else {
        format!("{SYSTEM_PROMPT}\n\n【设定资料】（写作时必须严格遵守）\n{lore_section}")
    };

    let summary_block = if summary_section.is_empty() {
        String::new()
    } else {
        format!("【前情摘要】\n{summary_section}\n\n")
    };

    let outline_block = if outline_section.is_empty() {
        String::new()
    } else {
        format!("【全书大纲】（写作时遵循当前进度节点的走向）\n{outline_section}\n")
    };

    let user = format!(
        "{summary_block}{outline_block}【前文】\n{}\n\n【续写要求】\n{}",
        if context_tail.trim().is_empty() {
            "（这是一个新章节的开头，请直接开始创作）"
        } else {
            &context_tail
        },
        instruction
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "自然衔接上文，继续往下写约 500 字。".to_string())
    );

    llm::stream_chat(
        cfg,
        vec![
            ("system".to_string(), system),
            ("user".to_string(), user),
        ],
        channel,
    )
    .await
    .map_err(|e| e.to_string())
}

/// 划词处理：改写 / 润色 / 扩写
#[tauri::command]
pub async fn ai_transform(
    db: State<'_, Db>,
    chapter_id: i64,
    mode: String,
    selected_text: String,
    channel: Channel<StreamEvent>,
) -> Result<(), String> {
    let chapter = db.get_chapter(chapter_id).map_err(|e| e.to_string())?;
    let cfg = load_llm_config(&db);

    let (mode_label, requirement) = match mode.as_str() {
        "rewrite" => (
            "改写",
            "将这段文字换一种表达方式重写，保持原意、人称与叙事视角不变，保持网文的节奏感。",
        ),
        "polish" => (
            "润色",
            "润色这段文字：修正语病、提升文采与画面感，不改变情节与信息量，篇幅基本不变。",
        ),
        "expand" => (
            "扩写",
            "扩写这段文字：保持情节走向不变，丰富动作、心理、环境等细节描写，篇幅扩充到原来的 2~3 倍。",
        ),
        _ => return Err(format!("未知的处理模式: {mode}")),
    };

    if selected_text.trim().is_empty() {
        return Err("选中的内容为空".to_string());
    }

    // 上下文 + 设定注入（与续写同一套规则，保证人设一致）
    let plain = db::html_to_text(&chapter.content);
    let context_tail = tail_chars(&plain, 1500);
    let entries = db
        .list_lore_entries(chapter.project_id)
        .unwrap_or_default();
    let lore_context = format!("{context_tail}\n{selected_text}");
    let (lore_section, injected) = build_lore_section(&entries, &lore_context);

    let note = if injected.is_empty() {
        format!("{mode_label}｜未注入设定")
    } else {
        format!("{mode_label}｜已注入设定：{}", injected.join("、"))
    };
    let _ = channel.send(StreamEvent::Meta { note });

    let system = if lore_section.is_empty() {
        TRANSFORM_SYSTEM_PROMPT.to_string()
    } else {
        format!("{TRANSFORM_SYSTEM_PROMPT}\n\n【设定资料】（必须严格遵守）\n{lore_section}")
    };

    let user = format!(
        "【上下文参考】\n{}\n\n【待处理段落】\n{}\n\n【处理要求】\n{}",
        if context_tail.trim().is_empty() {
            "（无）"
        } else {
            &context_tail
        },
        selected_text.trim(),
        requirement
    );

    llm::stream_chat(
        cfg,
        vec![
            ("system".to_string(), system),
            ("user".to_string(), user),
        ],
        channel,
    )
    .await
    .map_err(|e| e.to_string())
}

/// 生成章节摘要（非流式），存库并返回
#[tauri::command]
pub async fn generate_summary(db: State<'_, Db>, chapter_id: i64) -> Result<String, String> {
    let chapter = db.get_chapter(chapter_id).map_err(|e| e.to_string())?;
    let cfg = load_llm_config(&db);
    let plain = db::html_to_text(&chapter.content);
    let summary = summarize_chapter_text(&cfg, &chapter.title, &plain).await?;
    db.save_summary(chapter_id, &summary)
        .map_err(|e| e.to_string())?;
    Ok(summary)
}

/// 摘要生成的共享实现（单章/批量都用）
async fn summarize_chapter_text(
    cfg: &LlmConfig,
    title: &str,
    plain: &str,
) -> Result<String, String> {
    if plain.trim().is_empty() {
        return Err(format!("《{title}》还没有内容，无法生成摘要"));
    }
    // 长章截断：开头 + 结尾，兼顾主线与结局
    let excerpt = if plain.chars().count() > 6000 {
        format!(
            "{}\n……（中段略）……\n{}",
            head_chars(plain, 3500),
            tail_chars(plain, 2000)
        )
    } else {
        plain.to_string()
    };

    llm::chat_once(
        cfg.clone(),
        vec![
            (
                "system".to_string(),
                "你是小说编辑，擅长提炼章节梗概。只输出摘要本身，不要解释。".to_string(),
            ),
            (
                "user".to_string(),
                format!(
                    "请用 150 字以内概括以下章节：主要情节推进、人物状态变化、埋下的伏笔。\n\n【章节《{title}》内容】\n{excerpt}"
                ),
            ),
        ],
    )
    .await
    .map_err(|e| e.to_string())
}

/// 批量补齐缺失的摘要（带进度事件）
#[tauri::command]
pub async fn generate_missing_summaries(
    db: State<'_, Db>,
    project_id: i64,
    channel: Channel<ProgressEvent>,
) -> Result<(), String> {
    let chapters = db
        .list_chapters_missing_summary(project_id)
        .map_err(|e| e.to_string())?;
    let total = chapters.len() as i64;
    if total == 0 {
        let _ = channel.send(ProgressEvent::Done);
        return Ok(());
    }
    let cfg = load_llm_config(&db);

    for (i, ch) in chapters.iter().enumerate() {
        let _ = channel.send(ProgressEvent::Progress {
            current: i as i64,
            total,
            label: ch.title.clone(),
        });
        let plain = db::html_to_text(&ch.content);
        match summarize_chapter_text(&cfg, &ch.title, &plain).await {
            Ok(s) => {
                if let Err(e) = db.save_summary(ch.id, &s) {
                    let _ = channel.send(ProgressEvent::Error {
                        message: format!("《{}》摘要保存失败: {e}", ch.title),
                    });
                    return Ok(());
                }
            }
            Err(e) => {
                let _ = channel.send(ProgressEvent::Error {
                    message: format!("《{}》摘要生成失败: {e}", ch.title),
                });
                return Ok(());
            }
        }
    }
    let _ = channel.send(ProgressEvent::Progress {
        current: total,
        total,
        label: "完成".to_string(),
    });
    let _ = channel.send(ProgressEvent::Done);
    Ok(())
}

/// (总章节数, 已有摘要数)
#[tauri::command]
pub fn summary_stats(db: State<'_, Db>, project_id: i64) -> Result<(i64, i64), String> {
    db.summary_stats(project_id).map_err(|e| e.to_string())
}

// ---------- 体检 ----------

const CHECK_SYSTEM_PROMPT: &str = "你是一位资深的网络小说主编，负责成稿体检。\
仔细核对提供的设定资料与各章摘要，找出以下四类问题：\n\
1. 设定冲突：正文与设定资料矛盾（人物年龄/能力/关系/外貌前后不一致等）\n\
2. 时间线矛盾：事件先后顺序、时间跨度不合理\n\
3. 伏笔问题：疑似埋设但未回收的伏笔，或回收得过于仓促\n\
4. 逻辑漏洞：情节推进不合理之处\n\n\
输出要求：Markdown 分节输出（## 设定冲突 / ## 时间线 / ## 伏笔台账 / ## 逻辑漏洞 / ## 总体评价）。\
每个问题给出：问题描述、涉及章节、严重程度（高/中/低）、修改建议。\
伏笔台账用列表逐条列出：伏笔内容、埋设章节、状态（已回收/未回收/疑似未回收）。\
某类没有发现问题就明确写「未发现」。不要编造摘要中不存在的情节。";

const CHECK_LORE_BUDGET: usize = 4000;
const CHECK_SUMMARY_BUDGET: usize = 8000;

#[tauri::command]
pub async fn check_consistency(
    db: State<'_, Db>,
    project_id: i64,
    channel: Channel<StreamEvent>,
) -> Result<(), String> {
    let cfg = load_llm_config(&db);
    let (total, with_summary) = db.summary_stats(project_id).map_err(|e| e.to_string())?;
    if with_summary == 0 {
        return Err("还没有任何章节摘要，请先「补齐摘要」再体检".to_string());
    }

    // 设定资料（全量启用词条，预算内）
    let entries = db.list_lore_entries(project_id).map_err(|e| e.to_string())?;
    let mut lore_section = String::new();
    for e in entries.iter().filter(|e| e.enabled) {
        let block = format!("◆ {}（{}）\n{}\n\n", e.title, e.category, e.content.trim());
        if lore_section.len() + block.len() > CHECK_LORE_BUDGET {
            break;
        }
        lore_section.push_str(&block);
    }

    // 全部章节摘要（order_index 上限取最大，即不过滤）
    let summaries = db
        .list_summaries_before(project_id, i64::MAX)
        .map_err(|e| e.to_string())?;
    let mut summary_section = String::new();
    for (title, summary) in &summaries {
        let line = format!("《{title}》{}\n", summary.trim());
        if summary_section.len() + line.len() > CHECK_SUMMARY_BUDGET {
            summary_section.push_str("……（更多章节摘要因长度省略）\n");
            break;
        }
        summary_section.push_str(&line);
    }

    let _ = channel.send(StreamEvent::Meta {
        note: format!(
            "体检范围：设定 {} 条｜摘要 {}/{} 章",
            entries.iter().filter(|e| e.enabled).count(),
            with_summary,
            total
        ),
    });

    let missing_note = if with_summary < total {
        format!("\n\n注意：共 {total} 章，其中 {} 章缺少摘要，未纳入本次检查。", total - with_summary)
    } else {
        String::new()
    };

    let user = format!(
        "【设定资料】\n{}\n【各章摘要】\n{}{}",
        if lore_section.trim().is_empty() {
            "（未提供设定资料）\n"
        } else {
            &lore_section
        },
        summary_section,
        missing_note
    );

    llm::stream_chat(
        cfg,
        vec![
            ("system".to_string(), CHECK_SYSTEM_PROMPT.to_string()),
            ("user".to_string(), user),
        ],
        channel,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_check_report(
    db: State<'_, Db>,
    project_id: i64,
    content: String,
) -> Result<i64, String> {
    db.save_check_report(project_id, &content)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_check_reports(
    db: State<'_, Db>,
    project_id: i64,
) -> Result<Vec<crate::db::CheckReportMeta>, String> {
    db.list_check_reports(project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_check_report(db: State<'_, Db>, id: i64) -> Result<String, String> {
    db.get_check_report(id).map_err(|e| e.to_string())
}

/// 取开头若干字符
fn head_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

// ---------- 大纲 ----------

#[tauri::command]
pub fn list_outline(db: State<'_, Db>, project_id: i64) -> Result<Vec<OutlineItem>, String> {
    db.list_outline(project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_outline_item(
    db: State<'_, Db>,
    project_id: i64,
    title: String,
) -> Result<OutlineItem, String> {
    db.add_outline_item(project_id, &title)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_outline_item(
    db: State<'_, Db>,
    id: i64,
    title: String,
    content: String,
) -> Result<(), String> {
    db.save_outline_item(id, &title, &content)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_outline_status(db: State<'_, Db>, id: i64, status: String) -> Result<(), String> {
    db.set_outline_status(id, &status)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_outline_item(db: State<'_, Db>, id: i64) -> Result<(), String> {
    db.delete_outline_item(id).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct OutlineDraft {
    title: String,
    content: String,
}

/// AI 生成分卷大纲：依据简介 + 设定库 + 已有章节数，产出 5~8 个节点
#[tauri::command]
pub async fn generate_outline(
    db: State<'_, Db>,
    project_id: i64,
) -> Result<Vec<OutlineItem>, String> {
    let cfg = load_llm_config(&db);
    let project = db
        .list_projects()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or("作品不存在")?;

    let entries = db.list_lore_entries(project_id).unwrap_or_default();
    let lore: String = entries
        .iter()
        .filter(|e| e.enabled)
        .map(|e| format!("◆ {}（{}）{}", e.title, e.category, e.content.trim()))
        .collect::<Vec<_>>()
        .join("\n");
    let lore = head_chars(&lore, 2000);
    let chapter_count = db.summary_stats(project_id).map(|(t, _)| t).unwrap_or(0);

    let raw = llm::chat_once(
        cfg,
        vec![
            (
                "system".to_string(),
                "你是网文主编，擅长搭建长篇连载的分卷大纲。\
                根据作品简介与设定，产出 5~8 个分卷/情节节点，节奏符合网文规律（开局钩子、黄金三章、\
                第一个高潮、中期升级、后期爆发、结局预留）。\
                只输出 JSON 数组：[{\"title\": \"节点名（如：卷一·惊蛰之变）\", \"content\": \"本卷主线与关键转折，80字内\"}…]，\
                不要输出其他内容。"
                    .to_string(),
            ),
            (
                "user".to_string(),
                format!(
                    "【书名】《{}》\n【简介】\n{}\n\n【设定资料】\n{}\n\n（当前已有 {} 章正文）",
                    project.name,
                    if project.synopsis.is_empty() {
                        &project.description
                    } else {
                        &project.synopsis
                    },
                    if lore.is_empty() { "（暂无设定）" } else { &lore },
                    chapter_count
                ),
            ),
        ],
    )
    .await
    .map_err(|e| e.to_string())?;

    let start = raw.find('[').ok_or("大纲结果不是 JSON 数组")?;
    let end = raw.rfind(']').ok_or("大纲结果不是 JSON 数组")?;
    let drafts: Vec<OutlineDraft> = serde_json::from_str(&raw[start..=end])
        .map_err(|e| format!("大纲 JSON 解析失败: {e}"))?;
    let items: Vec<(String, String)> = drafts
        .into_iter()
        .map(|d| (d.title.trim().to_string(), d.content.trim().to_string()))
        .filter(|(t, _)| !t.is_empty())
        .collect();
    if items.is_empty() {
        return Err("大纲结果为空，请重试".to_string());
    }
    db.replace_outline(project_id, &items)
        .map_err(|e| e.to_string())?;
    db.list_outline(project_id).map_err(|e| e.to_string())
}

/// AI 润色创意：把用户的一句话创意扩写完善成更具体的创作 brief
#[tauri::command]
pub async fn ai_polish_idea(db: State<'_, Db>, idea: String) -> Result<String, String> {
    if idea.trim().is_empty() {
        return Err("请先写一句创意".to_string());
    }
    let cfg = load_llm_config(&db);
    llm::chat_once(
        cfg,
        vec![
            (
                "system".to_string(),
                "你是资深网络小说策划。把用户的一句话创意润色扩写成更具体的创作 brief：\
                补足题材定位、主角画像、金手指机制、核心冲突与爽点节奏。\
                保留用户原意的核心，不要改成别的故事。150~250 字，一段连贯的文字。\
                直接输出润色后的创意，不要解释，不要列条目。"
                    .to_string(),
            ),
            ("user".to_string(), format!("【原始创意】\n{}", idea.trim())),
        ],
    )
    .await
    .map_err(|e| e.to_string())
}

// ---------- AI 起书 ----------

/// AI 创建草稿：书名 + 简介 + 初始设定词条
#[derive(Debug, Serialize, Deserialize)]
pub struct BootstrapDraft {
    pub name: String,
    pub description: String,
    /// 番茄风长简介
    #[serde(default)]
    pub synopsis: String,
    pub lore: Vec<BootstrapLore>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BootstrapLore {
    pub category: String,
    pub title: String,
    pub content: String,
    pub keywords: String,
    pub always_include: bool,
}

const BOOTSTRAP_SYSTEM: &str = "你是资深网络小说策划，深谙网文市场与读者口味。\
根据用户的一句话创意，策划一部新书。\
只输出 JSON 对象，格式：\
{\"name\": \"书名（2~6字，有网感）\", \"description\": \"题材+一句话卖点，20字内\", \
\"synopsis\": \"番茄小说风格的作品简介，100~150字：第一句就是钩子（反常/悬念/冲突），\
点出金手指或最大看点，结尾抛悬念或反转预告，短句有节奏感\", \
\"lore\": [{\"category\": \"分类\", \"title\": \"词条名\", \"content\": \"设定内容\", \
\"keywords\": \"触发词,逗号分隔\", \"always_include\": true}…]}，不要输出任何其他内容。\
lore 生成 4~6 条，必须包含：\
① 主角人物卡（category 人物，always_include=true，content 含外貌/性格/口头禅/金手指，keywords 用主角姓名与昵称）；\
② 核心对手或张力源（人物）；③ 世界观（世界观）；④ 金手指或核心规则（其他）。\
category 只能是：人物 / 世界观 / 地点 / 物品 / 伏笔 / 其他。";

#[tauri::command]
pub async fn ai_bootstrap_draft(
    db: State<'_, Db>,
    idea: String,
) -> Result<BootstrapDraft, String> {
    if idea.trim().is_empty() {
        return Err("请先写一句创意".to_string());
    }
    let cfg = load_llm_config(&db);
    let raw = llm::chat_once(
        cfg,
        vec![
            ("system".to_string(), BOOTSTRAP_SYSTEM.to_string()),
            ("user".to_string(), format!("【创意】\n{}", idea.trim())),
        ],
    )
    .await
    .map_err(|e| e.to_string())?;

    let start = raw.find('{').ok_or("策划结果不是 JSON")?;
    let end = raw.rfind('}').ok_or("策划结果不是 JSON")?;
    let mut draft: BootstrapDraft =
        serde_json::from_str(&raw[start..=end]).map_err(|e| format!("策划 JSON 解析失败: {e}"))?;

    // 分类兜底 + 过滤空词条
    const VALID: [&str; 6] = ["人物", "世界观", "地点", "物品", "伏笔", "其他"];
    draft.lore.retain(|l| !l.title.trim().is_empty());
    for l in &mut draft.lore {
        if !VALID.contains(&l.category.as_str()) {
            l.category = "其他".to_string();
        }
    }
    if draft.name.trim().is_empty() {
        return Err("策划结果缺少书名，请重试".to_string());
    }
    Ok(draft)
}
