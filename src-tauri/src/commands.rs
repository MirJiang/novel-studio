//! Tauri 命令：前端 invoke 的全部入口

use crate::db::{self, Chapter, ChapterMeta, Db, LoreEntry, OutlineItem, Project, Task};
use crate::image_gen::{self, ImageConfig};
use crate::llm::{self, LlmConfig, LlmProtocol, StreamEvent};
use crate::tasks::TaskEnd;
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// 批量任务的进度事件（如批量生成摘要）
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProgressEvent {
    Progress {
        current: i64,
        total: i64,
        label: String,
    },
    Done,
    Error {
        message: String,
    },
}

// ---------- 作品 ----------

#[tauri::command]
pub fn create_project(
    db: State<'_, Db>,
    name: String,
    description: Option<String>,
    target_total_words: Option<i64>,
    target_chapter_words: Option<i64>,
    style_id: Option<i64>,
) -> Result<Project, String> {
    db.create_project(
        &name,
        description.as_deref().unwrap_or(""),
        target_total_words.unwrap_or(0),
        target_chapter_words.unwrap_or(0),
        style_id.unwrap_or(0),
    )
    .map_err(|e| e.to_string())
}

/// 更新作品字数目标（全书总字数 / 每章字数）
#[tauri::command]
pub fn update_project_targets(
    db: State<'_, Db>,
    id: i64,
    target_total_words: i64,
    target_chapter_words: i64,
) -> Result<(), String> {
    db.update_project_targets(id, target_total_words, target_chapter_words)
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
                去AI味硬约束：钩子落在具体的反常事件或细节上，不落抽象大词；禁三连排比与「这不是X，而是Y」；\
                禁「命运的齿轮」「一场关于XX的XX」类空话；不用仿佛/一丝/一抹等高频词；结尾抛悬念，不写感悟升华。\
                只输出简介正文，不要书名、不要解释。"
                    .to_string(),
            ),
            (
                "user".to_string(),
                format!(
                    "【设定资料】\n{}\n\n【首章氛围】\n{}",
                    if lore.is_empty() {
                        "（暂无）"
                    } else {
                        &lore
                    },
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

/// 上传人物卡参考图：复制到应用数据目录并记录路径，返回存储路径。
/// 每次换新文件名（旧文件删除）——前端用 asset 协议直读磁盘，同路径覆盖会被缓存坑
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
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = dir.join(format!("entry-{entry_id}-{ts}.{ext}"));
    std::fs::copy(&src_path, &dest).map_err(|e| format!("复制参考图失败: {e}"))?;
    if let Ok(old) = db.get_lore_entry(entry_id) {
        if !old.ref_image.is_empty() && old.ref_image != dest.to_string_lossy() {
            let _ = std::fs::remove_file(&old.ref_image);
        }
    }
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

/// 设定图统一尺寸：横版 16:9（三视图并排 / 场景全景都合适）
const LORE_IMAGE_SIZE: &str = "1920x1080";

/// AI 生成词条设定图：按分类选模板（人物=正/侧/背三视图，地点=场景概念图，
/// 物品=设定集图，其余=概念插画），存为参考图（覆盖旧的）。
/// 调研结论（docs/research-video-2026-08.md）：三视图参考比单图跨镜一致性明显更稳
#[tauri::command]
pub async fn generate_lore_ref_image(
    app: AppHandle,
    db: State<'_, Db>,
    entry_id: i64,
    style: Option<String>,
) -> Result<String, String> {
    let entry = db.get_lore_entry(entry_id).map_err(|e| e.to_string())?;
    if entry.content.trim().is_empty() {
        return Err("词条内容为空，先写点描述再生成".to_string());
    }
    let desc: String = entry.content.trim().chars().take(300).collect();
    let title = entry.title.trim();
    let prompt = match entry.category.as_str() {
        "人物" => format!(
            "角色设定三视图：同一人物「{title}」的正面、侧面、背面三个视角并排站立，全身像，统一姿势，纯色简洁背景。\
             人物描述：{desc}。精致动漫人设图风格，线条清晰，色彩明快，画面中无文字"
        ),
        "地点" => format!(
            "场景概念图：「{title}」。场景描述：{desc}。\
             宽幅全景视角，环境概念设计图风格，空间层次与光线氛围明确，细节丰富，画面中无文字"
        ),
        "物品" => format!(
            "物品设定图：「{title}」。物品描述：{desc}。\
             主体居中完整展示，纯色简洁背景，设定集插画风格，材质与形制细节清晰，画面中无文字"
        ),
        _ => format!(
            "概念插画：「{title}」。描述：{desc}。\
             构图完整，氛围明确，精致插画风格，画面中无文字"
        ),
    };
    // 画风锚点（风格库 image 卡/内置预设），追加在描述后统一风格
    let prompt = match style.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => format!("{prompt}，{s}"),
        None => prompt,
    };
    let cfg = load_image_config(&db);
    let bytes = image_gen::generate_image(&cfg, &prompt, LORE_IMAGE_SIZE, &[])
        .await
        .map_err(|e| e.to_string())?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("lore_refs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // 每次换新文件名（旧文件删除）：asset 协议按路径缓存，同路径覆盖会显示旧图
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = dir.join(format!("entry-{entry_id}-{ts}.png"));
    std::fs::write(&dest, &bytes).map_err(|e| format!("保存设定图失败: {e}"))?;
    if !entry.ref_image.is_empty() {
        let _ = std::fs::remove_file(&entry.ref_image);
    }
    let dest_str = dest.to_string_lossy().to_string();
    db.set_lore_ref_image(entry_id, &dest_str)
        .map_err(|e| e.to_string())?;
    Ok(dest_str)
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
pub fn export_project(db: State<'_, Db>, project_id: i64, path: String) -> Result<String, String> {
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
    /// 实际使用的画面描述（留空自动总结时回传，前端回填展示）
    prompt: String,
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
    style: Option<String>,
) -> Result<CoverResult, String> {
    // 描述留空：根据书名/题材/简介/首章氛围自动总结画面描述
    let mut prompt = if prompt.trim().is_empty() {
        summarize_cover_prompt(&db, project_id).await?
    } else {
        prompt.trim().to_string()
    };
    // 画风锚点（风格库 image 卡/内置预设）：追加在描述后，统一画面风格
    if let Some(s) = style.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        prompt = format!("{prompt}，{s}");
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
        prompt,
    })
}

/// 封面描述留空时：根据作品信息自动总结一段画面描述
async fn summarize_cover_prompt(db: &Db, project_id: i64) -> Result<String, String> {
    let cfg = load_llm_config(db);
    let project = db
        .list_projects()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "作品不存在".to_string())?;

    let entries = db.list_lore_entries(project_id).unwrap_or_default();
    let lore: String = entries
        .iter()
        .filter(|e| e.enabled)
        .map(|e| format!("◆ {}（{}）{}", e.title, e.category, e.content.trim()))
        .collect::<Vec<_>>()
        .join("\n");
    let lore = head_chars(&lore, 800);

    // 首章开头当氛围参考（新书可能没有正文）
    let first_chapter = db
        .list_chapter_bodies(project_id)
        .ok()
        .and_then(|b| b.into_iter().next())
        .map(|(_, c)| head_chars(&crate::db::html_to_text(&c), 600))
        .unwrap_or_default();

    llm::chat_once(
        cfg,
        vec![
            (
                "system".to_string(),
                "你是小说封面设计师，擅长把作品气质翻译成画面。\
                输出一段 60~100 字的封面画面描述：主体形象/场景、风格（如古风玄幻/都市悬疑）、\
                色调氛围、构图。画面里不要出现任何文字、字母或水印。\
                只输出画面描述本身，不要解释。"
                    .to_string(),
            ),
            (
                "user".to_string(),
                format!(
                    "【书名】《{}》\n【题材】{}\n【简介】\n{}\n\n【设定资料】\n{}\n\n【正文氛围】\n{}",
                    project.name,
                    if project.description.is_empty() { "（未填）" } else { &project.description },
                    if project.synopsis.trim().is_empty() { "（暂无）" } else { project.synopsis.trim() },
                    if lore.is_empty() { "（暂无）" } else { &lore },
                    if first_chapter.is_empty() { "（暂无正文）" } else { &first_chapter }
                ),
            ),
        ],
    )
    .await
    .map_err(|e| e.to_string())
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

// ---------- AI ----------

/// 带给前文的最多字符数
const CONTEXT_TAIL_CHARS: usize = 3000;

/// 设定注入的字符预算，防止 prompt 膨胀
const MAX_LORE_CHARS: usize = 2000;

/// 前情摘要注入的字符预算
const MAX_SUMMARY_CHARS: usize = 1500;

// 写作方法论内置自 chinese-webnovel-skill（webnovel-writing）的网文方法论，见 D24；
// 去AI味负面清单源自 oh-story story-deslop 禁用词表，见 docs/research-deai-2026-08.md（D29）
const SYSTEM_PROMPT: &str = "你是一位经验丰富的中文网文作家（番茄/起点商业网文向）。\
根据给定的前文继续写作，保持文风、叙事视角、人称与设定一致。\n\
【章法】\n\
- 每章回答四件事：主角这章想做什么、什么在阻止他、写完局面和开头有什么不同、读者凭什么看下一章；\
不写只过桥不落事的过渡章\n\
- 章内结构：开头几句就有抓手（不平铺日常、不回顾前文、不写天气），中段推进剧情/关系/信息，\
后段让局面变化，章末停在变化发生的那一拍\n\
- 每场戏都有目标、阻碍、变化；角色一边行动一边给信息，不站原地谈感受\n\
- 铺垫与回收：留意前情摘要里未回收的伏笔，到位置就呼应回收；本章适度埋设新铺垫\
（一个细节/一句台词/一件道具），为后文高潮蓄力，不平铺直叙\n\
- 章末留后劲：新危机/被迫选择/真相一角/关系变化/爽点预告，任选其一；\
不收在总结句、讲道理或把悬念解释没的解释上\n\
【语言】\n\
- 对白要有目的：带新信息、带关系位置、带压迫感；每个人说话带身份感，不像说明书\n\
- 描写与对话交替推进：连续静态描写（环境/外貌/心理）不超过两段就用对话或动作打断，\
能用对话交代的信息不用叙述——大段匀速描写是 AI 检测和读者观感的双重重灾区\n\
- 能用动作不用总结，能用对白不用解释，能写具体不写抽象；不堆辞藻\n\
【去AI味】（硬约束，成稿前逐条自查）\n\
- 禁用词：仿佛、宛如、犹如、一丝、一抹、些许、几分、隐约、深吸一口气、缓缓、不禁、\
微微、轻轻、淡淡、眼中闪过、嘴角勾起、眉头微皱、瞳孔骤缩、心中一动、心中一沉、难以言喻\n\
- 禁用句式：三句以上排比、「不是A，而是B」高频复现、「他感到…」「那是一种…的感觉」、\
「…般的」「…似的」、「空气仿佛凝固」「静得能听见针落」\n\
- 情绪不直接命名，用动作、生理反应或对话行为外化（不写“他很恐惧”，写他的手在抖）\n\
- 描写做减法：紧张/冲突场景不插大段静态描写（外貌罗列/环境说明/名词解释），形容词克制，\
一句至多两个，动词名词优先\n\
- 对话少用“××说道/问道”标签，允许打断、省略、答非所问，带口语颗粒\n\
- 段落长短错落，穿插一两句的短段；每段结尾不总结不抒情，章末停在动作或对话上\n\
【人味】（人类写作的统计指纹，成稿前自查）\n\
- 句长要有波动：偶尔一个词收尾（“他没动。”），偶尔一句拉长到两三行——连续三句字数\
相近就改一句，匀速节奏是机器指纹\n\
- 用词避开第一反应：脑子里最先蹦出的那个词如果太顺太通用，换一个更具体、更贴这个场景的\
（“安全”的词=高频词=AI味）\n\
- 保留毛边：允许口语插入语（“怎么说呢”“得”）、破折号打断、半句改口——真人写作不完美，\
太干净反而不像人写的\n\
【画面感】\n\
- 重要人物、场景、关键物品首次登场时，顺着角色的视线或动作自然带出具体外观\
（长相/穿着/标志物、环境布局/光线/氛围、物品材质/形制），一两句融入叙事，\
不罗列、不停下来说明——这些细节会被用于封面与视频生成\n\
- 已在设定资料里登记的外貌/环境细节，再次写到时保持一致\n\
直接输出正文内容，不要输出章节标题、解释或任何元信息。";

const TRANSFORM_SYSTEM_PROMPT: &str = "你是一位经验丰富的中文网文编辑。\
按用户要求处理给定段落，保持文风、叙事视角、人称与设定一致。\n\
语言硬要求：能用动作不用总结，能用对白不用解释，能写具体不写抽象；\
对白要带身份感和目的；不堆网文套话和辞藻，句式长短错落，情绪靠动作和反应落地而不是直接命名。\n\
去AI味硬约束：不用 仿佛/一丝/一抹/深吸一口气/眼中闪过/嘴角勾起/心中一动 等高频词；\
不写三连排比与「不是A，而是B」；句式长短错落，结尾不总结升华。\
直接输出处理后的正文，不要输出解释或任何元信息。";

/// 去AI味改写要求：划词「去AI味」与批量写章去味 pass 共用。
/// 六条压缩自 oh-story story-deslop 六门禁（词表替换→句式→心理外化→节奏→对话→结尾），见 docs/research-deai-2026-08.md
const DESLOP_REQUIREMENT: &str = "去掉这段文字的AI味，只改味不改故事：保持人称、视角、情节与信息量不变，篇幅基本不变（删凑字描写后允许略短）。逐条自查：\n\
1. 替换 AI 高频词（仿佛、宛如、犹如、一丝、一抹、些许、隐约、深吸一口气、缓缓、不禁、\
微微、轻轻、淡淡、眼中闪过、嘴角勾起、眉头微皱、瞳孔骤缩、心中一动、心中一沉、难以言喻），\
换成具体动作或直陈其事\n\
2. 拆掉套路句式：三句以上排比、「不是A，而是B」、「他感到…」、「…般的」「…似的」、\
「空气仿佛凝固」类套话\n\
3. 心理描写外化：情绪改用动作、生理反应、对话行为呈现，不直接命名\n\
4. 打破均匀节奏：超长复合句拆短，长段之间穿插一两句的短段\n\
5. 对话去腔调：能删的「说道/问道」标签就删，允许打断、省略、答非所问\n\
6. 描写做减法：删掉不为剧情或情绪服务的环境/心理/外貌描写（凑字数的水段，\
含紧张场景里插入的大段静态描写），删后不补；形容词一句至多两个\n\
7. 段落结尾不总结、不抒情、不升华\n\
8. 回人味（加法，最后做）：句长拉开波动——偶尔一个词收尾、偶尔一句拉长；\
用具体词替换太顺太通用的词；保留或补一两处口语毛边（插入语、顿挫、答非所问），\
允许不完美——太干净反而假\n\
只输出改写后的正文，不要解释。";

pub(crate) fn load_llm_config(db: &Db) -> LlmConfig {
    let read = |key: &str, default: &str| {
        db.get_setting(key)
            .ok()
            .flatten()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| default.to_string())
    };
    let base_url = read("llm_base_url", "https://api.deepseek.com/v1");
    // 协议只两套（D27）：显式设置优先；未设置时按域名自动识别 Claude
    let protocol = match read("llm_protocol", "").as_str() {
        "anthropic" => LlmProtocol::Anthropic,
        "openai" => LlmProtocol::OpenAI,
        _ if base_url.contains("anthropic") => LlmProtocol::Anthropic,
        _ => LlmProtocol::OpenAI,
    };
    LlmConfig {
        base_url,
        api_key: read("llm_api_key", ""),
        model: read("llm_model", "deepseek-chat"),
        protocol,
    }
}

fn tail_chars(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let start = chars.len().saturating_sub(max);
    chars[start..].iter().collect()
}

/// 命中规则：常驻注入，或任一关键词出现在上下文中。
/// 注入时融合（D31）：命中的词条连同它的全量变更时间线一起注入——词条是开书快照，
/// [剧情状态] 是台账事件流，AI 看到的永远是"当前状态"，不受全局近期窗口限制
pub(crate) fn build_lore_section(
    entries: &[LoreEntry],
    context_text: &str,
    ledger: &[db::LoreChangeRow],
) -> (String, Vec<String>) {
    let mut section = String::new();
    let mut titles = Vec::new();
    for e in entries.iter().filter(|e| e.enabled) {
        let hit = e.always_include
            || e.keywords
                .split([',', '，'])
                .map(str::trim)
                .filter(|k| !k.is_empty())
                .any(|k| context_text.contains(k));
        if !hit {
            continue;
        }
        let (timeline, tl_count) = entry_change_lines(ledger, e);
        let block = format!(
            "◆ {}（{}）\n{}{}\n\n",
            e.title,
            e.category,
            e.content.trim(),
            timeline
        );
        if section.len() + block.len() > MAX_LORE_CHARS {
            break; // 超预算就截断，保证 prompt 可控
        }
        section.push_str(&block);
        // 注入明细可观测（红线4）：词条名带上融合的剧情状态条数，崩了能分清"没写设定"还是"没注入时间线"
        titles.push(if tl_count == 0 {
            e.title.clone()
        } else {
            format!("{}（含剧情状态{tl_count}条）", e.title)
        });
    }
    (section, titles)
}

/// 单词条时间线预算：最多带最近 8 条、合计 ≤280 字（超出的更早变更省略——远期梗概兜底）
const ENTRY_CHANGE_KEEP: usize = 8;
const ENTRY_CHANGE_CHARS: usize = 280;

/// 词条的 [剧情状态] 段 + 实际注入条数：该词条全量变更按章节正序（从最近往回取到预算内，再反转），
/// 退场/登场带标记；无变更返回 (空串, 0)
fn entry_change_lines(ledger: &[db::LoreChangeRow], e: &LoreEntry) -> (String, usize) {
    let mut mine: Vec<&db::LoreChangeRow> = ledger
        .iter()
        .filter(|c| c.entry_id == Some(e.id) || c.entry_title == e.title)
        .collect();
    if mine.is_empty() {
        return (String::new(), 0);
    }
    mine.sort_by_key(|c| c.chapter_order);
    let omitted = mine.len().saturating_sub(ENTRY_CHANGE_KEEP);
    let mut picked: Vec<String> = Vec::new();
    let mut total = 0usize;
    for c in mine.iter().rev().take(ENTRY_CHANGE_KEEP) {
        let tag = match c.kind.as_str() {
            "new" => "登场",
            "retire" => "退场",
            _ => "",
        };
        let line = if tag.is_empty() {
            format!("第{}章：{}", c.chapter_order, c.detail.trim())
        } else {
            format!("第{}章{}：{}", c.chapter_order, tag, c.detail.trim())
        };
        if total + line.len() > ENTRY_CHANGE_CHARS && !picked.is_empty() {
            break;
        }
        total += line.len();
        picked.push(line);
    }
    let count = picked.len();
    picked.reverse();
    (
        format!(
            "\n[剧情状态]（当前状态以此为准{}）{}",
            if omitted > 0 {
                format!("，更早 {omitted} 条已略")
            } else {
                String::new()
            },
            picked.join("；")
        ),
        count,
    )
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

/// 远期梗概合计注入预算（超出保最新——更早期卷的走向大纲已覆盖）
const ERA_CHARS: usize = 600;

/// 写作记忆区块：远期梗概（era_summaries 压缩记忆）+ 近期章摘要（verbatim，近期优先）。
/// 返回 (区块文本, 远期梗概段数)；没压缩过远期时就是纯摘要（与旧行为一致）
fn build_memory_section(
    db: &Db,
    project_id: i64,
    next_order: i64,
    summaries: &[(String, String)],
) -> (String, usize) {
    let eras: Vec<db::EraSummary> = db
        .list_era_summaries(project_id)
        .unwrap_or_default()
        .into_iter()
        .filter(|e| e.order_end < next_order)
        .collect();
    let era_count = eras.len();
    let mut parts: Vec<String> = Vec::new();
    if era_count > 0 {
        let joined = eras
            .iter()
            .map(|e| e.text.trim())
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if !joined.is_empty() {
            parts.push(format!(
                "【远期梗概】（更早章节的压缩记忆）\n{}",
                tail_chars(&joined, ERA_CHARS)
            ));
        }
    }
    let recent = build_summary_section(summaries);
    if !recent.is_empty() {
        parts.push(format!("【前情摘要】\n{recent}"));
    }
    (parts.join("\n\n"), era_count)
}

/// 风格注入的字符预算（风格卡 800 + 真人语感锚点 200）
const MAX_STYLE_CHARS: usize = 800;
const MAX_STYLE_EXAMPLE_CHARS: usize = 200;

/// 作品绑定的写作风格：返回 (风格名, 注入段)；未绑定或风格卡为空时返回 None。
/// 蒸馏卡的 example 是真人原文片段——抽象描述教不会语感，真人片段才教得会（A5 人味锚点）
pub(crate) fn style_section(db: &Db, project_id: i64) -> Option<(String, String)> {
    let project = db
        .list_projects()
        .ok()?
        .into_iter()
        .find(|p| p.id == project_id)?;
    if project.style_id <= 0 {
        return None;
    }
    let style = db.get_style(project.style_id).ok()??;
    let guide = style.guide.trim();
    if guide.is_empty() {
        return None;
    }
    let mut section = format!(
        "【写作风格】（正文须模仿以下风格特征）\n{}",
        head_chars(guide, MAX_STYLE_CHARS)
    );
    // 真人语感锚点（A5）：蒸馏时摘的真人原文片段，few-shot 直接模仿语感与呼吸——不抄内容
    let example = style.example.trim();
    if !example.is_empty() {
        section.push_str(&format!(
            "\n\n【真人语感参照】（模仿这段真人文字的语感、节奏与呼吸，绝不抄内容）\n{}",
            head_chars(example, MAX_STYLE_EXAMPLE_CHARS)
        ));
    }
    Some((style.name.clone(), section))
}

/// 大纲注入的字符预算
const MAX_OUTLINE_CHARS: usize = 600;

/// 全书大纲区块：节点名 + 状态，首个未完成节点标记为当前进度（带本卷已写章数与卷目标）。
/// 卷 = 大纲节点；章数进度 + 收卷节奏纪律是给 AI 的节拍器，防少数几章冲完一卷；
/// 当前卷的 content（阶段目标/主要冲突/末局面变化）一并注入——AI 要知道这一卷在打什么
fn build_outline_section(
    items: &[OutlineItem],
    counts: &std::collections::HashMap<i64, i64>,
) -> String {
    if items.is_empty() {
        return String::new();
    }
    let first_planned = items.iter().position(|i| i.status != "done");
    let mut out = String::new();
    for (i, item) in items.iter().enumerate() {
        let mark = if Some(i) == first_planned {
            let n = counts.get(&item.id).copied().unwrap_or(0);
            let goal = if item.content.trim().is_empty() {
                String::new()
            } else {
                format!("——本卷目标：{}", head_chars(item.content.trim(), 80))
            };
            if item.target_chapters > 0 {
                format!(
                    " ◀当前卷（已写 {n} 章 / 全卷预计约 {} 章）{goal}",
                    item.target_chapters
                )
            } else {
                format!(" ◀当前卷（已写 {n} 章）{goal}")
            }
        } else if item.status == "done" {
            "【已完成】".to_string()
        } else {
            String::new()
        };
        let line = format!("{}. {}{}\n", i + 1, item.title, mark);
        if out.len() + line.len() > MAX_OUTLINE_CHARS {
            out.push_str("……（后续节点略）\n");
            break;
        }
        out.push_str(&line);
    }
    // 节奏提示：有预估章数时按进度分阶段（铺陈/中段/收尾），没有就给通用纪律
    if let Some(fp) = first_planned {
        let cur = &items[fp];
        let n = counts.get(&cur.id).copied().unwrap_or(0);
        if cur.target_chapters > 0 {
            let phase = if n * 10 < cur.target_chapters * 5 {
                "铺陈期：逐步升级冲突、埋设本卷看点，远未到收束时"
            } else if n * 10 < cur.target_chapters * 8 {
                "中段：保持升级节奏，阻力源持续加码"
            } else {
                "收尾阶段：开始收束本卷核心冲突、兑现高潮，为下一卷留钩子"
            };
            out.push_str(&format!("本卷节奏：{phase}。\n"));
        } else {
            out.push_str("节奏纪律：一卷通常铺几十章，按当前卷的阶段目标逐步升级冲突，不要提前写完本卷核心矛盾。\n");
        }
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

    // 设定库注入（D31 注入时融合）：常驻/关键词命中词条 + 各自的变更时间线
    let entries = db.list_lore_entries(chapter.project_id).unwrap_or_default();
    let ledger = db
        .list_lore_changes(chapter.project_id, None, None)
        .unwrap_or_default();
    let (lore_section, injected) = build_lore_section(&entries, &context_tail, &ledger);

    // 前情摘要注入：远期梗概（压缩记忆）+ 近期章摘要
    let summaries = db
        .list_summaries_before(chapter.project_id, chapter.order_index)
        .unwrap_or_default();
    let (summary_section, era_count) = build_memory_section(
        &db,
        chapter.project_id,
        chapter.order_index,
        &summaries,
    );

    // 大纲注入：全书节点 + 当前进度标记（管控整本书的走向）
    let outline = db.list_outline(chapter.project_id).unwrap_or_default();
    let outline_counts = db
        .count_chapters_by_outline(chapter.project_id)
        .unwrap_or_default();
    let outline_section = build_outline_section(&outline, &outline_counts);

    // 写作风格注入（创建作品时选定的风格卡）
    let style = style_section(&db, chapter.project_id);

    // 把注入明细告知前端（可观测性：崩了能分清是没写设定还是没注入）
    let mut notes = Vec::new();
    notes.push(if injected.is_empty() {
        "未注入设定".to_string()
    } else {
        format!("已注入设定：{}", injected.join("、"))
    });
    if let Some((name, _)) = &style {
        notes.push(format!("风格：{name}"));
    }
    if !summaries.is_empty() {
        notes.push(format!("前情摘要 {} 章", summaries.len()));
        if era_count > 0 {
            notes.push(format!("远期梗概 {era_count} 段"));
        }
    } else if chapter.order_index > 1 {
        notes.push("前情摘要缺失（可在章节里点「生成摘要」）".to_string());
    }
    if !outline.is_empty() {
        notes.push(format!("大纲 {} 节", outline.len()));
    }
    let _ = channel.send(StreamEvent::Meta {
        note: notes.join("｜"),
    });

    let mut system = if lore_section.is_empty() {
        SYSTEM_PROMPT.to_string()
    } else {
        format!("{SYSTEM_PROMPT}\n\n【设定资料】（写作时必须严格遵守，[剧情状态] 为当前状态）\n{lore_section}")
    };
    if let Some((_, section)) = &style {
        system.push_str("\n\n");
        system.push_str(section);
    }

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
        vec![("system".to_string(), system), ("user".to_string(), user)],
        channel,
    )
    .await
    .map_err(|e| e.to_string())
}

/// 划词处理：改写 / 润色 / 扩写 / 去AI味
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
        "deslop" => ("去AI味", DESLOP_REQUIREMENT),
        _ => return Err(format!("未知的处理模式: {mode}")),
    };

    if selected_text.trim().is_empty() {
        return Err("选中的内容为空".to_string());
    }

    // 上下文 + 设定注入（与续写同一套规则，保证人设一致）
    let plain = db::html_to_text(&chapter.content);
    let context_tail = tail_chars(&plain, 1500);
    let entries = db.list_lore_entries(chapter.project_id).unwrap_or_default();
    let lore_context = format!("{context_tail}\n{selected_text}");
    let ledger = db
        .list_lore_changes(chapter.project_id, None, None)
        .unwrap_or_default();
    let (lore_section, injected) = build_lore_section(&entries, &lore_context, &ledger);

    let note = if injected.is_empty() {
        format!("{mode_label}｜未注入设定")
    } else {
        format!("{mode_label}｜已注入设定：{}", injected.join("、"))
    };
    let _ = channel.send(StreamEvent::Meta { note });

    let style = style_section(&db, chapter.project_id);
    let mut system = if lore_section.is_empty() {
        TRANSFORM_SYSTEM_PROMPT.to_string()
    } else {
        format!("{TRANSFORM_SYSTEM_PROMPT}\n\n【设定资料】（必须严格遵守）\n{lore_section}")
    };
    if let Some((_, section)) = &style {
        system.push_str("\n\n");
        system.push_str(section);
    }

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
        vec![("system".to_string(), system), ("user".to_string(), user)],
        channel,
    )
    .await
    .map_err(|e| e.to_string())
}

/// 生成章节摘要（非流式），存库并返回；顺带提取本章设定变更进台账（失败不影响摘要）
#[tauri::command]
pub async fn generate_summary(db: State<'_, Db>, chapter_id: i64) -> Result<String, String> {
    let chapter = db.get_chapter(chapter_id).map_err(|e| e.to_string())?;
    let cfg = load_llm_config(&db);
    let plain = db::html_to_text(&chapter.content);
    let summary = summarize_chapter_text(&cfg, &chapter.title, &plain).await?;
    db.save_summary(chapter_id, &summary)
        .map_err(|e| e.to_string())?;
    if let Err(e) = extract_chapter_lore_changes(&db, &cfg, chapter_id).await {
        eprintln!("设定变更提取失败（章节 {chapter_id}）: {e}");
    }
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
    let excerpt = chapter_excerpt(plain);

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

/// 长章截断：开头 + 结尾，兼顾主线与结局
fn chapter_excerpt(plain: &str) -> String {
    if plain.chars().count() > 6000 {
        format!(
            "{}\n……（中段略）……\n{}",
            head_chars(plain, 3500),
            tail_chars(plain, 2000)
        )
    } else {
        plain.to_string()
    }
}

/// 批量写章用：章节名 + 摘要一次 LLM 调用产出。
/// 返回 (完整章节名, 摘要)；失败回退为 (序号标题, "")
async fn chapter_title_and_summary(
    cfg: &LlmConfig,
    fallback_title: &str,
    plain: &str,
) -> (String, String) {
    if plain.trim().is_empty() {
        return (fallback_title.to_string(), String::new());
    }
    let excerpt = chapter_excerpt(plain);
    let resp = llm::chat_once(
        cfg.clone(),
        vec![
            (
                "system".to_string(),
                "你是小说编辑。阅读章节内容，只输出两行：\n\
                第一行：本章标题（2~10 个汉字，概括本章最大看点，不要“第X章”前缀，不要书名号）\n\
                第二行：本章摘要（150 字以内：主要情节推进、人物状态变化、埋下的伏笔）\n\
                只输出这两行，不要其他任何内容。"
                    .to_string(),
            ),
            ("user".to_string(), format!("【章节内容】\n{excerpt}")),
        ],
    )
    .await;

    let Ok(text) = resp else {
        return (fallback_title.to_string(), String::new());
    };
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let name = lines
        .next()
        .unwrap_or("")
        .trim_start_matches("标题")
        .trim_matches(|c| c == '：' || c == ':' || c == ' ')
        .trim();
    let summary = lines
        .collect::<Vec<_>>()
        .join("\n")
        .trim_start_matches("摘要")
        .trim_matches(|c| c == '：' || c == ':' || c == ' ')
        .trim()
        .to_string();
    let title = if name.is_empty() || name.chars().count() > 20 {
        fallback_title.to_string()
    } else {
        format!("{fallback_title} · {name}")
    };
    (title, summary)
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
                // 顺带提取设定变更进台账（失败继续下一章）
                if let Err(e) = extract_chapter_lore_changes(&db, &cfg, ch.id).await {
                    eprintln!("设定变更提取失败（章节 {}）: {e}", ch.id);
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

// ---------- 设定变更台账 ----------

const LORE_CHANGES_SYSTEM: &str = "你是小说设定管理员。阅读章节内容，做三件事：\
1.【变更】找出对设定状态产生持久变更的事实：新登场的重要人物/地点/物品/伏笔，已有设定的状态变化\
（获得/失去/境界提升/区域解锁/关系破裂…），设定退场或失效。打完就结束的战斗、一次性对话等过程性事件不算。\
2.【实体】登记本章新出现的所有具体元素——有名有姓或有称呼的人物（含配角）、任何具体物件\
（武器/道具/信物/消耗品，哪怕一把无关紧要的小刀）、具体地点、功法/技能名称。\
已在【已登记词条】清单里的跳过；每条给一两句说明（外观/来历/用途/与谁相关），正文没写的不要编。\
3.【关系】提取本章建立或改变的人物-物品/人物-人物关系，谓词用：拥有/失去/使用/师承/敌对/结盟/属于/居住/创建。
只输出一个 JSON 对象（各段可为空数组），不要解释：\
{\"changes\": [{\"entry_title\": \"条目名（与设定库条目一致；新事物用简洁命名）\", \
\"category\": \"人物/世界观/地点/物品/功法/伏笔/其他\", \"kind\": \"new|update|retire\", \
\"detail\": \"一句话说明本章造成的变更\"}], \
\"entities\": [{\"category\": \"人物/世界观/地点/物品/功法/其他\", \"title\": \"名称\", \"desc\": \"一两句说明\"}], \
\"relations\": [{\"subject\": \"主体名\", \"predicate\": \"拥有/失去/使用/师承/敌对/结盟/属于/居住/创建\", \"object\": \"对象名\"}]}";

#[derive(Debug, serde::Deserialize)]
struct RawLoreChange {
    entry_title: Option<String>,
    category: Option<String>,
    kind: Option<String>,
    detail: Option<String>,
}

/// 提取输出的实体与关系段（宽容解析：缺字段当空）
#[derive(Debug, serde::Deserialize, Default)]
struct RawExtract {
    #[serde(default)]
    changes: Vec<RawLoreChange>,
    #[serde(default)]
    entities: Vec<RawEntity>,
    #[serde(default)]
    relations: Vec<RawRelation>,
}

#[derive(Debug, serde::Deserialize)]
struct RawEntity {
    category: Option<String>,
    title: Option<String>,
    desc: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct RawRelation {
    subject: Option<String>,
    predicate: Option<String>,
    object: Option<String>,
}

/// 从章节提取设定变更（共享实现：手动命令 + 摘要链路自动挂载）。
/// 产出整章替换（重复提取幂等）；返回三段统计
async fn extract_chapter_lore_changes(
    db: &Db,
    cfg: &LlmConfig,
    chapter_id: i64,
) -> Result<ExtractOutcome, String> {
    let chapter = db.get_chapter(chapter_id).map_err(|e| e.to_string())?;
    let plain = db::html_to_text(&chapter.content);
    if plain.trim().is_empty() {
        return Ok(ExtractOutcome::default());
    }
    let excerpt = chapter_excerpt(&plain);

    // 带上现有条目清单，AI 才能把变更归到已有条目而不是重复"新登场"
    let entries = db.list_lore_entries(chapter.project_id).unwrap_or_default();
    let lore_brief = head_chars(
        &entries
            .iter()
            .filter(|e| e.enabled)
            .map(|e| {
                format!(
                    "◆ {}（{}）{}",
                    e.title,
                    e.category,
                    head_chars(e.content.trim(), 80)
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        1500,
    );

    let raw = llm::chat_once(
        cfg.clone(),
        vec![
            ("system".to_string(), LORE_CHANGES_SYSTEM.to_string()),
            (
                "user".to_string(),
                format!(
                    "【本章《{}》内容】\n{}\n\n【现有设定条目】\n{}",
                    chapter.title,
                    excerpt,
                    if lore_brief.is_empty() { "（暂无）" } else { &lore_brief }
                ),
            ),
        ],
    )
    .await
    .map_err(|e| e.to_string())?;

    // 宽容解析：优先对象（三段输出）；失败退回数组（旧格式纯变更），再不行当空（自动链路不报错）
    let parsed: RawExtract = if let (Some(s), Some(e)) = (raw.find('{'), raw.rfind('}')) {
        if e > s {
            serde_json::from_str(&raw[s..=e]).unwrap_or_default()
        } else {
            RawExtract::default()
        }
    } else if let (Some(s), Some(e)) = (raw.find('['), raw.rfind(']')) {
        let legacy: Vec<RawLoreChange> = if e > s {
            serde_json::from_str(&raw[s..=e]).unwrap_or_default()
        } else {
            Vec::new()
        };
        RawExtract {
            changes: legacy,
            ..Default::default()
        }
    } else {
        RawExtract::default()
    };
    const VALID_CATS: [&str; 7] = ["人物", "世界观", "地点", "物品", "功法", "伏笔", "其他"];
    let rows: Vec<db::NewLoreChange> = parsed
        .changes
        .into_iter()
        .filter_map(|r| {
            let title = r.entry_title?.trim().to_string();
            let detail = r.detail.unwrap_or_default().trim().to_string();
            if title.is_empty() || detail.is_empty() {
                return None;
            }
            let category = r.category.unwrap_or_default().trim().to_string();
            let kind = match r.kind.as_deref().map(str::trim) {
                Some("new") => "new",
                Some("retire") => "retire",
                _ => "update",
            };
            let entry_id = entries
                .iter()
                .find(|e| e.title.trim() == title)
                .map(|e| e.id);
            Some(db::NewLoreChange {
                entry_id,
                entry_title: title,
                category: if VALID_CATS.contains(&category.as_str()) {
                    category
                } else {
                    "其他".to_string()
                },
                kind: kind.to_string(),
                detail,
            })
        })
        .collect();
    let count = rows.len();
    db.replace_lore_changes(chapter.project_id, chapter_id, &rows)
        .map_err(|e| e.to_string())?;

    // 新实体登记入库（穷尽收集融入自动链路）：keywords=标题、非常驻，词条多不伤注入预算
    let mut titles: Vec<String> = entries.iter().map(|e| e.title.trim().to_string()).collect();
    let mut created = 0usize;
    for ent in parsed.entities {
        let title = match ent.title {
            Some(t) => t.trim().to_string(),
            None => continue,
        };
        if title.is_empty() || titles.iter().any(|t| *t == title) {
            continue;
        }
        let category = ent.category.unwrap_or_default().trim().to_string();
        let category = if VALID_CATS.contains(&category.as_str()) {
            category
        } else {
            "其他".to_string()
        };
        let e = db
            .create_lore_entry(chapter.project_id, &title, &category)
            .map_err(|e| e.to_string())?;
        db.update_lore_entry(&crate::db::LoreEntry {
            content: ent.desc.unwrap_or_default().trim().to_string(),
            keywords: title.clone(),
            ..e
        })
        .map_err(|e| e.to_string())?;
        titles.push(title);
        created += 1;
    }

    // 关系入库（整章替换幂等）
    let rels: Vec<db::NewLoreRelation> = parsed
        .relations
        .into_iter()
        .filter_map(|r| {
            let s = r.subject?.trim().to_string();
            let o = r.object?.trim().to_string();
            let p = r.predicate.unwrap_or_default().trim().to_string();
            if s.is_empty() || o.is_empty() || p.is_empty() {
                return None;
            }
            Some(db::NewLoreRelation {
                subject: s,
                predicate: p,
                object: o,
            })
        })
        .collect();
    let _ = db.replace_lore_relations(chapter.project_id, chapter_id, &rels);
    Ok(ExtractOutcome {
        changes: count,
        entities: created,
        relations: rels.len(),
    })
}

/// 提取统计（批量写章收尾汇总进任务结果，用户可见设定库生长）
#[derive(Default, Clone, Copy)]
pub(crate) struct ExtractOutcome {
    pub changes: usize,
    pub entities: usize,
    pub relations: usize,
}

impl ExtractOutcome {
    fn is_empty(&self) -> bool {
        self.changes == 0 && self.entities == 0 && self.relations == 0
    }
    fn summary(&self) -> String {
        format!(
            "变更 {} · 新词条 {} · 关系 {}",
            self.changes, self.entities, self.relations
        )
    }
}

/// 手动提取某章的设定变更（台账视图「提取本章/补齐全部」按钮），返回三段统计说明
#[tauri::command]
pub async fn extract_lore_changes(db: State<'_, Db>, chapter_id: i64) -> Result<String, String> {
    let cfg = load_llm_config(&db);
    let o = extract_chapter_lore_changes(&db, &cfg, chapter_id).await?;
    Ok(if o.is_empty() {
        "本章没有可提取的设定信息".to_string()
    } else {
        o.summary()
    })
}

/// 按 id 或标题找设定词条（可变借用，活设定应用用）
fn find_entry_mut<'a>(
    entries: &'a mut [LoreEntry],
    entry_id: Option<i64>,
    title: &str,
) -> Option<&'a mut LoreEntry> {
    entries
        .iter_mut()
        .find(|e| Some(e.id) == entry_id || e.title.trim() == title.trim())
}

/// 应用台账变更到设定库（活设定，D31 重写式）：new→建词条；retire→停用；
/// update→LLM 把词条重写成"当前状态"叙述（原始卡+变更序列→一段干净的现在时描述，批量一次调用），
/// 重写前存快照（rollback_lore_apply 可回滚）。按章节顺序执行，应用过的不再重复；
/// 重新提取某章会整章重置为未应用。手动触发 + 批量写章收尾自动跑（auto_apply_lore 默认开）
#[tauri::command]
pub async fn apply_lore_changes(db: State<'_, Db>, project_id: i64) -> Result<String, String> {
    let cfg = load_llm_config(&db);
    apply_lore_changes_core(&db, &cfg, project_id).await
}

/// apply 核心（命令与批量收尾共用）。LLM 重写失败时对 update 回退机械追加，不中断
async fn apply_lore_changes_core(
    db: &Db,
    cfg: &LlmConfig,
    project_id: i64,
) -> Result<String, String> {
    let pending = db
        .list_unapplied_changes(project_id)
        .map_err(|e| e.to_string())?;
    if pending.is_empty() {
        return Ok("没有待应用的变更".to_string());
    }
    let mut entries = db.list_lore_entries(project_id).map_err(|e| e.to_string())?;
    let (mut created, mut retired, mut skipped) = (0, 0, 0);
    let mut applied_ids: Vec<i64> = Vec::new();
    // 待重写的词条：entry_id → 变更列表（章节序号 + 说明，时间正序）
    let mut rewrite_map: std::collections::BTreeMap<i64, Vec<(i64, String)>> =
        Default::default();

    let create_entry = |db: &Db,
                        entries: &mut Vec<LoreEntry>,
                        title: &str,
                        category: &str,
                        content: String|
     -> Result<(), String> {
        let mut e = db
            .create_lore_entry(project_id, title, category)
            .map_err(|e| e.to_string())?;
        e.content = content;
        e.keywords = title.to_string();
        db.update_lore_entry(&e).map_err(|e| e.to_string())?;
        entries.push(e);
        Ok(())
    };

    for c in &pending {
        match c.kind.as_str() {
            "retire" => match find_entry_mut(&mut entries, c.entry_id, &c.entry_title) {
                Some(e) => {
                    e.content = format!(
                        "{}\n[第{}章退场/失效] {}",
                        e.content.trim_end(),
                        c.chapter_order,
                        c.detail
                    );
                    e.enabled = false;
                    db.update_lore_entry(e).map_err(|e| e.to_string())?;
                    retired += 1;
                }
                None => skipped += 1,
            },
            "update" => match find_entry_mut(&mut entries, c.entry_id, &c.entry_title) {
                Some(e) => {
                    e.enabled = true; // 退场后又有新剧情：复活（重写时体现）
                    rewrite_map
                        .entry(e.id)
                        .or_default()
                        .push((c.chapter_order, c.detail.trim().to_string()));
                }
                None => {
                    // 词条不存在：当新登场建（AI 提取时词条库还没有它）
                    create_entry(
                        db,
                        &mut entries,
                        &c.entry_title,
                        &c.category,
                        format!("（第{}章登场）{}", c.chapter_order, c.detail),
                    )?;
                    created += 1;
                }
            },
            _ => {
                // new：已有同名词条（含停用）不重复建，交给人工合并
                if find_entry_mut(&mut entries, c.entry_id, &c.entry_title).is_some() {
                    skipped += 1;
                } else {
                    create_entry(
                        db,
                        &mut entries,
                        &c.entry_title,
                        &c.category,
                        format!("（第{}章登场）{}", c.chapter_order, c.detail),
                    )?;
                    created += 1;
                }
            }
        }
        applied_ids.push(c.id);
    }

    // update 批量重写：一次 LLM 调用把涉及的词条改成"当前状态"叙述（≤300字/词条）
    let mut rewritten = 0usize;
    if !rewrite_map.is_empty() {
        let targets: Vec<&LoreEntry> = entries
            .iter()
            .filter(|e| rewrite_map.contains_key(&e.id))
            .collect();
        let material: String = targets
            .iter()
            .map(|e| {
                let changes = rewrite_map
                    .get(&e.id)
                    .map(|cs| {
                        cs.iter()
                            .map(|(o, d)| format!("第{o}章：{d}"))
                            .collect::<Vec<_>>()
                            .join("；")
                    })
                    .unwrap_or_default();
                format!(
                    "【{}】（现有内容）{}\n（本章起剧情变更）{}\n",
                    e.title,
                    e.content.trim(),
                    changes
                )
            })
            .collect();
        let raw = llm::chat_once(
            cfg.clone(),
            vec![
                (
                    "system".to_string(),
                    "你是设定库管理员，把若干设定词条重写成\"当前状态\"叙述：\
                    合并现有内容与剧情变更，保留仍然成立的信息，过期状态改写为现状\
                    （如\"左臂第38章被贯穿\"若已接回则写\"左臂曾贯穿、已接回但经脉受损\"），\
                    删掉与现状矛盾的旧描述。每个词条 ≤300 字，保持客观设定口吻，不写流水账年份堆砌。\
                    只输出 JSON 数组：[{\"title\": \"词条名\", \"content\": \"重写后内容\"}]，逐条对应输入，不要解释。"
                        .to_string(),
                ),
                ("user".to_string(), material),
            ],
        )
        .await;

        // 先存快照（重写回滚依据）——无论 LLM 成败，本次应用涉及的词条都留底
        let ts = db::now_ts();
        db.snapshot_lore_entries(&targets, ts)
            .map_err(|e| e.to_string())?;

        match raw {
            Ok(json) => {
                #[derive(serde::Deserialize)]
                struct Rewritten {
                    title: String,
                    content: String,
                }
                let start = json.find('[');
                let end = json.rfind(']');
                let list: Vec<Rewritten> = match (start, end) {
                    (Some(s), Some(e)) if e > s => {
                        serde_json::from_str(&json[s..=e]).unwrap_or_default()
                    }
                    _ => Vec::new(),
                };
                for r in list {
                    if let Some(e) =
                        find_entry_mut(&mut entries, None, r.title.trim())
                    {
                        if r.content.trim().is_empty() {
                            continue;
                        }
                        e.content = r.content.trim().to_string();
                        db.update_lore_entry(e).map_err(|e| e.to_string())?;
                        rewritten += 1;
                    }
                }
            }
            Err(_) => {
                // LLM 失败回退机械追加（快照已存，仍可回滚）
                for (id, changes) in &rewrite_map {
                    if let Some(e) = entries.iter_mut().find(|e| e.id == *id) {
                        for (order, detail) in changes {
                            e.content = format!(
                                "{}\n[剧情更新·第{order}章] {detail}",
                                e.content.trim_end()
                            );
                        }
                        db.update_lore_entry(e).map_err(|e| e.to_string())?;
                        rewritten += 1;
                    }
                }
            }
        }
        let _ = rewritten;
        db.mark_changes_applied(&applied_ids, ts)
            .map_err(|e| e.to_string())?;
    } else {
        let ts = db::now_ts();
        db.mark_changes_applied(&applied_ids, ts)
            .map_err(|e| e.to_string())?;
    }

    Ok(format!(
        "已应用 {} 条：新登场 {created} · 重写更新 {rewritten} · 退场 {retired}{}（重写前已快照，可回滚）",
        pending.len(),
        if skipped > 0 {
            format!("（{skipped} 条已有同名词条，人工合并）")
        } else {
            String::new()
        }
    ))
}

/// 回滚最近一次应用：恢复词条快照 + 那批变更重置为未应用（重新提取/应用即重做）
#[tauri::command]
pub fn rollback_lore_apply(db: State<'_, Db>, project_id: i64) -> Result<String, String> {
    let ts = db
        .latest_apply_ts(project_id)
        .map_err(|e| e.to_string())?;
    if ts == 0 {
        return Ok("还没有应用过变更".to_string());
    }
    let (restored, unapplied) = db
        .rollback_lore_apply(project_id, ts)
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "已回滚上次应用：恢复 {restored} 个词条内容，{unapplied} 条变更回到待应用"
    ))
}

/// 分层记忆参数：近期摘要保留章数 / 压缩粒度（每 50 章一段梗概）/ 每段梗概输入预算
const RECENT_KEEP: usize = 15;
const ERA_GROUP: i64 = 50;
const ERA_INPUT_CHARS: usize = 6000;

/// 压缩远期摘要（分层记忆）：保留最近 RECENT_KEEP 章 verbatim，更早的每 50 章压成 ≤200 字梗概，
/// 存 era_summaries 供写作注入（build_memory_section）。已有完整覆盖同范围的段跳过（增量压缩），
/// 范围长大后重算并替换旧段。体检页入口，长篇写到后期点一次即可
#[tauri::command]
pub async fn compress_era_summaries(
    db: State<'_, Db>,
    project_id: i64,
    channel: Channel<ProgressEvent>,
) -> Result<String, String> {
    let cfg = load_llm_config(&db);
    let all = db
        .list_summaries_with_order(project_id)
        .map_err(|e| e.to_string())?;
    if all.len() <= RECENT_KEEP {
        return Ok("章节还不多，暂不需要压缩远期摘要".to_string());
    }
    let old = &all[..all.len() - RECENT_KEEP];
    // 按 50 章分桶（第 1~50、51~100 …；末桶按实际章数收口）
    let mut buckets: std::collections::BTreeMap<i64, Vec<&(i64, String, String)>> =
        std::collections::BTreeMap::new();
    for row in old {
        buckets
            .entry((row.0 - 1) / ERA_GROUP)
            .or_default()
            .push(row);
    }
    let existing = db.list_era_summaries(project_id).map_err(|e| e.to_string())?;
    let todo: Vec<(i64, i64, &Vec<&(i64, String, String)>)> = buckets
        .iter()
        .filter_map(|(b, rows)| {
            let start = b * ERA_GROUP + 1;
            let end = rows.last().map(|r| r.0).unwrap_or(start);
            // 已有段完整覆盖本桶才跳过；书变长后范围扩大要重算
            let covered = existing
                .iter()
                .any(|e| e.order_start <= start && e.order_end >= end);
            if covered {
                None
            } else {
                Some((start, end, rows))
            }
        })
        .collect();
    if todo.is_empty() {
        return Ok("远期梗概已是最新".to_string());
    }
    let total = todo.len() as i64;
    for (i, (start, end, rows)) in todo.iter().enumerate() {
        let _ = channel.send(ProgressEvent::Progress {
            current: i as i64,
            total,
            label: format!("压缩第 {start}~{end} 章"),
        });
        let joined = rows
            .iter()
            .map(|(o, t, s)| format!("第{o}章《{t}》{}", s.trim()))
            .collect::<Vec<_>>()
            .join("\n");
        let text = llm::chat_once(
            cfg.clone(),
            vec![
                (
                    "system".to_string(),
                    "你是网文责编，把一批章节摘要压缩成一段剧情梗概，供后续章节写作时当远期记忆。\
                    只保留对后续剧情有影响的：主线推进、重要人物的登场/退场/重大状态变化、\
                    关键物品与地图变化、未回收的重要伏笔。不超过 200 字，直接输出梗概正文，不要标题和解释。"
                        .to_string(),
                ),
                (
                    "user".to_string(),
                    format!(
                        "【章节摘要（第 {start}~{end} 章）】\n{}",
                        head_chars(&joined, ERA_INPUT_CHARS)
                    ),
                ),
            ],
        )
        .await
        .map_err(|e| format!("压缩第 {start}~{end} 章失败: {e}"))?;
        db.upsert_era_summary(project_id, *start, *end, text.trim())
            .map_err(|e| e.to_string())?;
    }
    let _ = channel.send(ProgressEvent::Progress {
        current: total,
        total,
        label: "完成".to_string(),
    });
    let _ = channel.send(ProgressEvent::Done);
    Ok(format!("已压缩 {total} 段远期梗概（每段约 50 章，写作时自动注入）"))
}

/// 台账列表（entry_id/entry_title 给值时按条目过滤，条目时间线用）
#[tauri::command]
pub fn list_lore_changes(
    db: State<'_, Db>,
    project_id: i64,
    entry_id: Option<i64>,
    entry_title: Option<String>,
) -> Result<Vec<db::LoreChangeRow>, String> {
    db.list_lore_changes(project_id, entry_id, entry_title.as_deref())
        .map_err(|e| e.to_string())
}

// ---------- 对话占比统计（本地启发式，AI 味的结构性指标） ----------

/// 引号内字符数（中英文引号/直角引号都认；AI 检测实测：对话段 AI 值显著低于大段描写）
fn dialogue_chars(text: &str) -> usize {
    let mut in_q = false;
    let mut n = 0usize;
    for c in text.chars() {
        match c {
            '“' | '「' => in_q = true,
            '”' | '」' => in_q = false,
            _ if in_q => n += 1,
            _ => {}
        }
    }
    n
}

#[derive(Debug, Serialize)]
pub struct DialogueStat {
    pub chapter_id: i64,
    pub title: String,
    pub words: i64,
    /// 引号内字符占正文字符比例（0~1）
    pub dialogue_ratio: f64,
}

#[derive(Debug, Serialize)]
pub struct DialogueStats {
    pub chapters: Vec<DialogueStat>,
    /// 全书对话占比（0~1）
    pub total_ratio: f64,
}

/// 分章对话占比：写作节奏的结构性体检——占比过低说明大段叙述/描写堆砌
#[tauri::command]
pub fn dialogue_stats(db: State<'_, Db>, project_id: i64) -> Result<DialogueStats, String> {
    let metas = db.list_chapters(project_id).map_err(|e| e.to_string())?;
    let bodies = db
        .list_chapter_bodies(project_id)
        .map_err(|e| e.to_string())?;
    let mut chapters = Vec::new();
    let (mut total_dlg, mut total_chars) = (0usize, 0usize);
    for (m, (_, html)) in metas.iter().zip(bodies.iter()) {
        let plain = db::html_to_text(html);
        let chars = plain.chars().count();
        if chars == 0 {
            continue;
        }
        let dlg = dialogue_chars(&plain);
        total_dlg += dlg;
        total_chars += chars;
        chapters.push(DialogueStat {
            chapter_id: m.id,
            title: m.title.clone(),
            words: m.word_count,
            dialogue_ratio: (dlg as f64 / chars as f64 * 1000.0).round() / 1000.0,
        });
    }
    Ok(DialogueStats {
        total_ratio: if total_chars == 0 {
            0.0
        } else {
            (total_dlg as f64 / total_chars as f64 * 1000.0).round() / 1000.0
        },
        chapters,
    })
}

/// 关系三元组列表（人物资产/反向查询，时间正序）
#[tauri::command]
pub fn list_lore_relations(
    db: State<'_, Db>,
    project_id: i64,
) -> Result<Vec<db::LoreRelationRow>, String> {
    db.list_lore_relations(project_id).map_err(|e| e.to_string())
}

/// 批量写章执行器（任务队列 kind = batch_chapters）。
///
/// 与 ai_continue 的关键差异：这里走 chat_once 拿全文直接落库（流式续写不落库，
/// 文本只在前端编辑器里），每章写完立即生成摘要，保证下一章的前情摘要链不断；
/// 进度写 tasks 表，前端轮询展示；取消在下一章开始前生效。
pub(crate) async fn run_batch_chapters(db: &Db, task: &Task) -> Result<TaskEnd, String> {
    const DEFAULT_CHAPTER_WORDS: i64 = 2000;

    #[derive(serde::Deserialize)]
    struct Payload {
        chapter_count: i64,
        words_per_chapter: i64,
    }
    let payload: Payload =
        serde_json::from_str(&task.payload).map_err(|e| format!("任务参数解析失败: {e}"))?;
    let project_id = task.project_id;

    let project = db
        .list_projects()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "作品不存在".to_string())?;

    // 每章字数：参数 > 作品设定 > 默认；钳制在合理区间
    let mut wpc = if payload.words_per_chapter > 0 {
        payload.words_per_chapter
    } else if project.target_chapter_words > 0 {
        project.target_chapter_words
    } else {
        DEFAULT_CHAPTER_WORDS
    };
    wpc = wpc.clamp(500, 10000);

    // 章数：不设上限，参数 <= 0 表示「写完整本书」，按总字数目标推算
    let mut count = payload.chapter_count;
    if count <= 0 {
        if project.target_total_words <= 0 {
            return Err(
                "还未设置全书目标字数：请先在弹层里填目标字数，或改为按章数生成".to_string(),
            );
        }
        let written = db.total_word_count(project_id).map_err(|e| e.to_string())?;
        let remaining = project.target_total_words - written;
        if remaining <= 0 {
            return Err(format!(
                "已达到全书目标字数（{} 字），无需再生成",
                project.target_total_words
            ));
        }
        count = (remaining + wpc - 1) / wpc;
    }
    count = count.max(1);

    let cfg = load_llm_config(db);
    let base_count = db.chapter_count(project_id).map_err(|e| e.to_string())?;
    // 断点自检间隔（设置里配，0 = 不暂停）
    let checkpoint_interval: i64 = db
        .get_setting("batch_checkpoint_interval")
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0);
    // 去AI味二遍 pass（设置里配，开启后每章生成后自跑一遍去味，耗时与成本约 ×2）
    let deslop = db
        .get_setting("batch_deslop")
        .ok()
        .flatten()
        .map(|v| v.trim() == "1")
        .unwrap_or(false);

    // 本次写成的章节（标题 + 摘要），供收尾时推进大纲
    let mut written: Vec<(String, String)> = Vec::new();
    // 本批设定库生长统计（收尾进任务结果，用户可见）
    let mut extract_total = ExtractOutcome::default();
    let mut cancelled = false;

    for i in 0..count {
        // 取消检查：当前章写完后在下一章开始前停下
        if crate::tasks::is_cancel_requested(task.id) {
            cancelled = true;
            break;
        }
        let chapter_no = base_count + i + 1;
        let title = format!("第 {chapter_no} 章");
        let _ = db.update_task_progress(task.id, i, count, &title);

        // 上文取当前最后一章的尾部（新章节此时还没建，last 就是它的前一章）
        let prev = db.last_chapter(project_id).map_err(|e| e.to_string())?;
        let context_tail = prev
            .as_ref()
            .map(|c| tail_chars(&db::html_to_text(&c.content), CONTEXT_TAIL_CHARS))
            .unwrap_or_default();

        // 设定注入（D31 注入时融合）：关键词匹配上下文 + 作品简介 + 各词条变更时间线
        let entries = db.list_lore_entries(project_id).unwrap_or_default();
        let lore_match_context = format!("{context_tail}\n{}", project.synopsis);
        let ledger = db
            .list_lore_changes(project_id, None, None)
            .unwrap_or_default();
        let (lore_section, _injected) =
            build_lore_section(&entries, &lore_match_context, &ledger);

        // 前情摘要 + 大纲（与 ai_continue 同一套注入链）
        let next_order = prev.as_ref().map(|c| c.order_index + 1).unwrap_or(1);
        let summaries = db
            .list_summaries_before(project_id, next_order)
            .unwrap_or_default();
        let (summary_section, _era_count) =
            build_memory_section(db, project_id, next_order, &summaries);
        let outline = db.list_outline(project_id).unwrap_or_default();
        let outline_counts = db.count_chapters_by_outline(project_id).unwrap_or_default();
        let outline_section = build_outline_section(&outline, &outline_counts);

        let style = style_section(db, project_id);
        let mut system = if lore_section.is_empty() {
            SYSTEM_PROMPT.to_string()
        } else {
            format!("{SYSTEM_PROMPT}\n\n【设定资料】（写作时必须严格遵守，[剧情状态] 为当前状态）\n{lore_section}")
        };
        if let Some((_, section)) = &style {
            system.push_str("\n\n");
            system.push_str(section);
        }
        let summary_block = if summary_section.is_empty() {
            String::new()
        } else {
            format!("{summary_section}\n\n")
        };
        let outline_block = if outline_section.is_empty() {
            String::new()
        } else {
            format!("【全书大纲】（写作时遵循当前进度节点的走向）\n{outline_section}\n")
        };
        // 全新书的第一章没有前文，用作品简介给 AI 定调
        let prev_block = if context_tail.trim().is_empty() {
            if project.synopsis.trim().is_empty() {
                "【前文】\n（这是一个新章节的开头，请直接开始创作）".to_string()
            } else {
                format!(
                    "【作品简介】\n{}\n\n【前文】\n（这是全书第一章，请依据简介直接开始创作）",
                    project.synopsis.trim()
                )
            }
        } else {
            format!("【前文】\n{context_tail}")
        };
        let max_words = wpc * 3 / 2;
        let user = format!(
            "{summary_block}{outline_block}{prev_block}\n\n【本章要求】\n本章为《{title}》。\
            自然衔接上文，直接创作本章完整正文，篇幅约 {wpc} 字（不要超过 {max_words} 字）。\
            顺应既有伏笔（该回收就回收），适度埋设新铺垫；\
            章末停在变化发生的那一拍，留后劲。"
        );

        let mut text = llm::chat_once(
            cfg.clone(),
            vec![("system".to_string(), system), ("user".to_string(), user)],
        )
        .await
        .map_err(|e| format!("《{title}》生成失败（已完成 {i} 章）: {e}"))?;

        // 去AI味二遍 pass：失败回退原文，不中断批量流程
        if deslop {
            let _ = db.update_task_progress(task.id, i, count, &format!("{title} 去AI味…"));
            if let Ok(t) = deslop_chapter_text(&cfg, &text).await {
                text = t;
            }
        }

        let chapter = db
            .create_chapter(project_id, &title)
            .map_err(|e| e.to_string())?;
        let html = text_to_html(&text);
        let plain = db::html_to_text(&html);

        // 章节名 + 摘要一次产出（失败就用序号标题、摘要留空，不中断流程）
        let (chapter_title, summary) = chapter_title_and_summary(&cfg, &title, &plain).await;
        db.save_chapter(chapter.id, &chapter_title, &html)
            .map_err(|e| format!("《{title}》保存失败（已完成 {i} 章）: {e}"))?;
        if !summary.is_empty() {
            let _ = db.save_summary(chapter.id, &summary);
        }
        // 顺带提取设定变更/实体/关系进库（失败不中断批量流程，统计进收尾报告）
        if let Ok(o) = extract_chapter_lore_changes(db, &cfg, chapter.id).await {
            extract_total.changes += o.changes;
            extract_total.entities += o.entities;
            extract_total.relations += o.relations;
        }
        written.push((chapter_title.clone(), summary));

        // 断点自检：每写满 interval 章暂停，AI 巡检本批章节后等用户决定继续/叫停
        if checkpoint_interval > 0
            && written.len() as i64 % checkpoint_interval == 0
            && (i + 1) < count
        {
            let _ = db.update_task_progress(task.id, i + 1, count, "自检中…");
            let from = written.len().saturating_sub(checkpoint_interval as usize);
            let report = checkpoint_review(db, &cfg, project_id, &written[from..]).await;
            return Ok(TaskEnd::Paused(format!(
                "已完成 {} 章｜巡检：{}",
                written.len(),
                report
            )));
        }
    }

    // 活设定自动应用（D31）：本批变更 LLM 重写进词条（默认开，设置 auto_apply_lore=0 关）
    if !written.is_empty() {
        let auto_apply = db
            .get_setting("auto_apply_lore")
            .ok()
            .flatten()
            .map(|v| v.trim() != "0")
            .unwrap_or(true);
        if auto_apply {
            let _ = db.update_task_progress(task.id, written.len() as i64, count, "设定库更新…");
            let _ = apply_lore_changes_core(db, &cfg, project_id).await;
        }
    }

    // 大纲自动推进：让 LLM 判断本次内容覆盖到第几个节点，标 done（失败静默跳过）
    if !written.is_empty() {
        let _ = db.update_task_progress(task.id, written.len() as i64, count, "推进大纲…");
        advance_outline(db, &cfg, project_id, &written).await;
    }

    let done_count = written.len() as i64;
    let _ = db.update_task_progress(
        task.id,
        done_count,
        count,
        if cancelled { "已取消" } else { "完成" },
    );
    let msg = format!(
        "新增 {done_count} 章{}",
        if extract_total.is_empty() || cancelled {
            String::new()
        } else {
            format!("｜设定库 +{} 词条 · {} 关系", extract_total.entities, extract_total.relations)
        }
    );
    if cancelled {
        Ok(TaskEnd::Cancelled(format!("{msg}（已取消）")))
    } else {
        Ok(TaskEnd::Done(msg))
    }
}

/// 去AI味 pass：整章正文去味改写（批量写章 batch_deslop=1 时逐章自跑，失败由调用方回退原文）
async fn deslop_chapter_text(cfg: &LlmConfig, text: &str) -> Result<String, String> {
    llm::chat_once(
        cfg.clone(),
        vec![
            (
                "system".to_string(),
                "你是中文网文去AI味编辑，按六条硬约束逐条自查改写正文，只改味不改故事。\
                直接输出改写后的正文，不要解释、不要标题。"
                    .to_string(),
            ),
            (
                "user".to_string(),
                format!("{DESLOP_REQUIREMENT}\n\n【正文】\n{text}"),
            ),
        ],
    )
    .await
    .map_err(|e| e.to_string())
}

/// 断点巡检：责编视角检查刚写的一批章节（连贯/设定/节奏），200 字简报
async fn checkpoint_review(
    db: &Db,
    cfg: &LlmConfig,
    project_id: i64,
    batch: &[(String, String)],
) -> String {
    let entries = db.list_lore_entries(project_id).unwrap_or_default();
    let lore: String = entries
        .iter()
        .filter(|e| e.enabled)
        .map(|e| format!("◆ {}（{}）{}", e.title, e.category, e.content.trim()))
        .collect::<Vec<_>>()
        .join("\n");
    let lore = head_chars(&lore, 1500);
    let chapters: String = batch
        .iter()
        .map(|(t, s)| format!("《{t}》{s}"))
        .collect::<Vec<_>>()
        .join("\n");

    let resp = llm::chat_once(
        cfg.clone(),
        vec![
            (
                "system".to_string(),
                "你是网文责编，巡检刚批量生成的一批章节。只看三件事：\
                剧情是否连贯（与前文有无矛盾）、是否违反设定、节奏是否崩（注水/过渡章连发）。\
                200 字以内给结论：没问题就写「通过」加一句点评；有问题按条列出并给修正建议。\
                只输出结论。"
                    .to_string(),
            ),
            (
                "user".to_string(),
                format!(
                    "【设定资料】\n{}\n\n【本批新写章节摘要】\n{}",
                    if lore.is_empty() { "（无）" } else { &lore },
                    chapters
                ),
            ),
        ],
    )
    .await;

    match resp {
        Ok(text) => text.trim().to_string(),
        Err(e) => format!("巡检调用失败：{e}"),
    }
}

/// 批量写完后的收尾：把本次覆盖到的大纲节点标为完成。
/// 章节数和大纲节点粒度不一致，交由 LLM 按摘要判断推进到第几节。
async fn advance_outline(db: &Db, cfg: &LlmConfig, project_id: i64, written: &[(String, String)]) {
    let items = db.list_outline(project_id).unwrap_or_default();
    if items.is_empty() || !items.iter().any(|i| i.status != "done") {
        return;
    }
    let outline_text = items
        .iter()
        .enumerate()
        .map(|(i, it)| {
            format!(
                "{}. {}{}",
                i + 1,
                it.title,
                if it.status == "done" {
                    "【已完成】"
                } else {
                    ""
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let chapters_text = written
        .iter()
        .map(|(t, s)| format!("《{t}》{s}"))
        .collect::<Vec<_>>()
        .join("\n");

    let resp = llm::chat_once(
        cfg.clone(),
        vec![
            (
                "system".to_string(),
                "你是小说大纲管理助手。根据本次新写的章节摘要，判断大纲推进到了第几个节点。\
                只输出一个阿拉伯数字（推进到的节点序号），不要输出任何其他内容。\
                如果没有明显推进就输出 0。"
                    .to_string(),
            ),
            (
                "user".to_string(),
                format!("【全书大纲】\n{outline_text}\n\n【本次新写章节】\n{chapters_text}\n\n问：本次内容推进到了第几个大纲节点？"),
            ),
        ],
    )
    .await;

    let Ok(text) = resp else { return };
    let digits: String = text.chars().filter(|c| c.is_ascii_digit()).collect();
    let Ok(n) = digits.parse::<usize>() else {
        return;
    };
    if n == 0 {
        return;
    }
    // 保守推进：一次批量最多完成一个卷节点——章节与节点粒度差异大，
    // LLM 判断容易一跳多格（10 章冲完半本大纲），宁慢勿抢
    let first_planned = items.iter().position(|i| i.status != "done");
    let Some(fp) = first_planned else { return };
    // 章数下限硬闸：当前卷有预估章数且实际章数不足六成，LLM 说到了也不许收卷
    let cur = &items[fp];
    if cur.target_chapters > 0 {
        let counts = db.count_chapters_by_outline(project_id).unwrap_or_default();
        let written = counts.get(&cur.id).copied().unwrap_or(0);
        if written * 5 < cur.target_chapters * 3 {
            return;
        }
    }
    let upto = n.min(fp + 2); // n 为 1-based 节点序号，fp+2 = 当前卷的下一格封顶
    for (idx, it) in items.iter().enumerate() {
        if idx < upto && it.status != "done" {
            let _ = db.set_outline_status(it.id, "done");
        }
    }
}

/// 手动调整章节所属卷（编辑器「所属卷」选择器；0 = 未分卷）
#[tauri::command]
pub fn set_chapter_volume(
    db: State<'_, Db>,
    chapter_id: i64,
    outline_item_id: i64,
) -> Result<(), String> {
    db.set_chapter_volume(chapter_id, outline_item_id)
        .map_err(|e| e.to_string())
}

/// LLM 输出的纯文本转章节 HTML：按行分段，空行跳过，转义实体
fn text_to_html(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| {
            let escaped = l
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;");
            format!("<p>{escaped}</p>")
        })
        .collect::<Vec<_>>()
        .join("")
}

/// (总章节数, 已有摘要数)
#[tauri::command]
pub fn summary_stats(db: State<'_, Db>, project_id: i64) -> Result<(i64, i64), String> {
    db.summary_stats(project_id).map_err(|e| e.to_string())
}

// ---------- 全书评分（真人书评视角） ----------

const CHECK_SYSTEM_PROMPT: &str = "你是一位阅文无数、口味挑剔的资深网文读者兼书评人，现在为一部长篇连载写总评。\
助手已把全书正文逐段通读完毕并做了笔记（见【全书评注】，覆盖每一章），你的评价以评注为事实底座。\
评价必须站在真人读者的角度：诚实、直接、有立场，不写客套话——真的好才夸，平庸就直说平庸，差就点出差在哪。\
评分要有区分度，不打保险分：9 分以上只给头部水准，7~8.9 好看可追，5~6.9 平庸能看，5 以下有明显硬伤。\
所有判断必须有据：引用评注中的具体章节、情节或原句，禁止「节奏紧凑引人入胜」这类放之四海皆准的套话。\
不要编造材料中不存在的情节；某段评注失败或材料明显不足时在对应小节明说，并降低评分置信度。\n\
输出 Markdown，严格按以下结构分节（## 标题一字不差）：\n\
## 总分\nX.X/10 —— 一句定调短评\n\
## 维度评分\n- 文笔：X.X/10 —— 一句依据\n- AI味：X.X/10 —— 一句依据（高频套话/句式套路/情绪不外化/结尾升华腔的密度，引用原句佐证）\n- 节奏：X.X/10 —— 一句依据\n- 人物塑造：X.X/10 —— 一句依据\n- 情节逻辑：X.X/10 —— 一句依据\n- 吸引力：X.X/10 —— 一句依据（爽点/钩子/追读欲）\n\
## 优点\n逐条列，每条带章节或情节依据\n\
## 缺点\n逐条列，每条带章节或情节依据；可以毒舌，但对文不对人\n\
## 文笔评价\n以【全书评注】摘引的原句为据，评价语感/句式/用词/画面感/对话自然度，摘出典型亮点句或病句；\
评注【问题】栏记有数量/称谓硬伤的（数字对不上、称呼与关系不符），逐条点名列出\n\
## 风格与主题贴合度\n对照【作品信息】【写作风格要求】【大纲】：题材卖点是否兑现、风格是否走样、主线是否偏离大纲，偏在哪里\n\
## 总评\n一段话收拢：这本书在追更市场上的位置、目标读者、最该先改的一件事";

/// 通读员（分批评注）prompt：全书正文逐段过一遍，笔记供总评引用
const ANNOTATE_SYSTEM_PROMPT: &str = "你是一位资深网文读者，正在通读一部长篇连载并做读书笔记，供稍后写总评引用。\
对给出的正文片段做评注（≤350 字），严格按四栏输出：\n\
【精彩】文笔佳句/精彩片段/爽点：摘原句并说清好在哪；没有就写「无」\n\
【问题】文笔毛病/逻辑漏洞/节奏拖沓/设定矛盾/数量称谓硬伤：引原句或情节；没有就写「无」\
（数量称谓硬伤指：前文说“四个字/三个人/五天”，后文数字对不上；称呼与人物关系不符；代词指代错人——AI 生成文的典型指纹）\n\
【贴合】正文与题材定位/写作风格要求的贴合观察（如走样、笔力不均）；没有可写的写「无」\n\
【印象】本段一句话印象 + 阶段印象分 X.X/10\n\
所有评价落到具体句子或情节，禁止「节奏紧凑引人入胜」这类套话；宁缺毋滥，不硬凑。";

const CHECK_LORE_BUDGET: usize = 4000;
const CHECK_SUMMARY_BUDGET: usize = 8000;
/// 大纲注入预算（评偏离主线用）
const CHECK_OUTLINE_BUDGET: usize = 1500;
/// 全书通读：每批正文目标字数（按章边界累积）
const CHECK_BATCH_CHARS: usize = 7000;
/// 通读并发路数（聊天补全接口，4 路礼貌且够快）
const CHECK_CONCURRENCY: usize = 4;
/// 注入总评的评注总预算（超出按段等距保留，头中尾都要有依据，不做尾部截断）
const ANNOTATION_BUDGET: usize = 24000;
/// 给通读员的风格卡上限（评注「贴合」栏的基准）
const ANNOTATE_STYLE_CHARS: usize = 300;

#[tauri::command]
pub async fn check_consistency(
    db: State<'_, Db>,
    project_id: i64,
    channel: Channel<StreamEvent>,
) -> Result<(), String> {
    use futures_util::StreamExt as _;

    let cfg = load_llm_config(&db);
    let (total, with_summary) = db.summary_stats(project_id).map_err(|e| e.to_string())?;

    let project = db
        .list_projects()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or("作品不存在")?;

    // 写作风格要求（作者绑定风格卡才有；通读「贴合」栏与总评「是否偏离风格」的基准）
    let style_block = if project.style_id > 0 {
        db.get_style(project.style_id)
            .ok()
            .flatten()
            .filter(|s| !s.guide.trim().is_empty())
            .map(|s| (s.name, s.guide.trim().to_string()))
    } else {
        None
    };

    // 大纲（评价主线偏离的基准，预算内逐节点）
    let outline = db.list_outline(project_id).map_err(|e| e.to_string())?;
    let mut outline_section = String::new();
    for (i, item) in outline.iter().enumerate() {
        let line = format!(
            "{}. {}（{}）：{}\n",
            i + 1,
            item.title,
            if item.status == "done" { "已完成" } else { "进行中" },
            item.content.trim()
        );
        if outline_section.len() + line.len() > CHECK_OUTLINE_BUDGET {
            outline_section.push_str("……（后续节点略）\n");
            break;
        }
        outline_section.push_str(&line);
    }

    // 设定资料（全量启用词条，预算内）
    let entries = db
        .list_lore_entries(project_id)
        .map_err(|e| e.to_string())?;
    let mut lore_section = String::new();
    for e in entries.iter().filter(|e| e.enabled) {
        let block = format!("◆ {}（{}）\n{}\n\n", e.title, e.category, e.content.trim());
        if lore_section.len() + block.len() > CHECK_LORE_BUDGET {
            break;
        }
        lore_section.push_str(&block);
    }

    // 全部章节摘要（可选增强：全书通读后不再必需，但有则更准）
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

    // ---------- 阶段一：全书正文分批通读 ----------

    // 逐章取正文，按章边界累积分批（每批约 7000 字，单章超长自为一批）
    let metas = db.list_chapters(project_id).map_err(|e| e.to_string())?;
    let mut chapters_text: Vec<(String, String)> = Vec::new();
    for m in &metas {
        let Ok(ch) = db.get_chapter(m.id) else { continue };
        let text = db::html_to_text(&ch.content).trim().to_string();
        if text.chars().count() >= 50 {
            chapters_text.push((ch.title, text));
        }
    }
    if chapters_text.is_empty() {
        return Err("章节正文为空（或几乎为空），没法评分".to_string());
    }
    let mut batches: Vec<Vec<(String, String)>> = Vec::new();
    let mut cur: Vec<(String, String)> = Vec::new();
    let mut cur_chars = 0usize;
    for (title, text) in chapters_text {
        let c = text.chars().count();
        if cur_chars + c > CHECK_BATCH_CHARS && !cur.is_empty() {
            batches.push(std::mem::take(&mut cur));
            cur_chars = 0;
        }
        cur_chars += c;
        cur.push((title, text));
    }
    if !cur.is_empty() {
        batches.push(cur);
    }

    let total_batches = batches.len();
    let book_info_line = format!(
        "《{}》{}",
        project.name,
        if project.description.trim().is_empty() {
            String::new()
        } else {
            format!("（{}）", project.description.trim())
        }
    );
    let style_for_annotator = style_block
        .as_ref()
        .map(|(n, g)| format!("「{n}」：{}", head_chars(g, ANNOTATE_STYLE_CHARS)))
        .unwrap_or_else(|| "（未绑定，按题材常规期待）".to_string());

    let _ = channel.send(StreamEvent::Meta {
        note: format!("开始通读全书：{} 章正文分 {} 段…", metas.len(), total_batches),
    });

    let done_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut annotations: Vec<(usize, String)> = futures_util::stream::iter(
        batches
            .into_iter()
            .enumerate()
            .map(|(bi, batch)| {
                let cfg = cfg.clone();
                let channel = channel.clone();
                let done = done_count.clone();
                let book_info = book_info_line.clone();
                let style = style_for_annotator.clone();
                async move {
                    let mut prose = String::new();
                    for (t, txt) in &batch {
                        prose.push_str(&format!("《{t}》\n{txt}\n\n"));
                    }
                    let user = format!(
                        "【作品】{book_info}\n【写作风格要求】{style}\n\
                         【本段为全书第 {}/{} 段】\n【正文】\n{}",
                        bi + 1,
                        total_batches,
                        prose
                    );
                    let result = llm::chat_once(
                        cfg,
                        vec![
                            ("system".to_string(), ANNOTATE_SYSTEM_PROMPT.to_string()),
                            ("user".to_string(), user),
                        ],
                    )
                    .await;
                    let n = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                    let _ = channel.send(StreamEvent::Meta {
                        note: format!("通读全书 {n}/{total_batches} 段…"),
                    });
                    let text = match result {
                        Ok(a) => a.trim().to_string(),
                        Err(e) => format!("（本段评注失败：{e}）"),
                    };
                    (bi, format!("—— 第 {} 段 ——\n{text}", bi + 1))
                }
            }),
    )
    .buffer_unordered(CHECK_CONCURRENCY)
    .collect()
    .await;
    annotations.sort_by_key(|(bi, _)| *bi);
    let annotations: Vec<String> = annotations.into_iter().map(|(_, a)| a).collect();

    // 评注超预算：按段等距保留（头中尾都要有依据，不截尾部）
    let total_ann: usize = annotations.iter().map(|a| a.len()).sum();
    let (annotation_section, injected) = if total_ann <= ANNOTATION_BUDGET {
        (annotations.join("\n\n"), annotations.len())
    } else {
        let keep = (ANNOTATION_BUDGET / 400).max(1).min(annotations.len());
        let step = annotations.len() as f64 / keep as f64;
        let mut picked: Vec<&str> = Vec::new();
        let mut i = 0f64;
        while (i as usize) < annotations.len() {
            picked.push(&annotations[i as usize]);
            i += step;
        }
        (
            format!(
                "（全书共 {} 段评注，因长度等距保留 {} 段，覆盖头中尾）\n{}",
                annotations.len(),
                picked.len(),
                picked.join("\n\n")
            ),
            picked.len(),
        )
    };

    // ---------- 阶段二：汇总流式评分 ----------

    let _ = channel.send(StreamEvent::Meta {
        note: format!(
            "评分素材：全书 {} 章分 {} 段通读评注（注入 {} 段）｜摘要 {}/{} 章｜风格：{}｜大纲 {} 节点",
            metas.len(),
            total_batches,
            injected,
            with_summary,
            total,
            style_block
                .as_ref()
                .map(|(n, _)| n.as_str())
                .unwrap_or("未绑定"),
            outline.len()
        ),
    });

    let missing_note = if with_summary < total {
        format!(
            "\n\n注意：共 {total} 章，其中 {} 章缺少摘要；摘要只是辅助，全书正文已逐段通读。",
            total - with_summary
        )
    } else {
        String::new()
    };

    let user = format!(
        "【作品信息】\n书名《{}》\n题材标签：{}\n简介：{}\n\n\
         【写作风格要求】\n{}\n\n\
         【大纲】\n{}\n\
         【设定资料】\n{}\n\
         【各章摘要】\n{}{}\n\
         【全书评注】（通读员逐段笔记，覆盖全书正文；文笔与精彩度以其中摘引的原句为据）\n{}",
        project.name,
        if project.description.trim().is_empty() {
            "（未设置）"
        } else {
            project.description.trim()
        },
        if project.synopsis.trim().is_empty() {
            "（未写简介，按正文实际呈现评价）"
        } else {
            project.synopsis.trim()
        },
        match &style_block {
            Some((name, guide)) => format!("作者绑定风格「{name}」，正文应贴合：\n{guide}"),
            None => "（作者未绑定写作风格，按题材常规期待评价）".to_string(),
        },
        if outline_section.is_empty() {
            "（未设置大纲，只评题材与风格贴合）\n"
        } else {
            &outline_section
        },
        if lore_section.trim().is_empty() {
            "（未提供设定资料）\n"
        } else {
            &lore_section
        },
        if summary_section.is_empty() {
            "（尚无章节摘要，情节脉络以全书评注为据）\n"
        } else {
            &summary_section
        },
        missing_note,
        annotation_section,
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

/// 评分报告 → 整改方案：LLM 按报告缺点/硬伤定位受影响章节、写跨章改写指令。
/// 前端展示方案后用既有 enqueue_rewrite_chapters 一键入队（快照回滚链路复用）
#[derive(Debug, serde::Serialize)]
pub struct CheckFixPlan {
    /// 给人看的方案说明（Markdown，3~6 条）
    pub plan: String,
    /// 给改写 AI 的完整指令
    pub instruction: String,
    /// 受影响章节（已解析为 id，按章节顺序）
    pub chapter_ids: Vec<i64>,
    pub chapter_titles: Vec<String>,
}

#[tauri::command]
pub async fn make_check_fix_plan(
    db: State<'_, Db>,
    project_id: i64,
    report_id: i64,
) -> Result<CheckFixPlan, String> {
    let report = db
        .get_check_report(report_id)
        .map_err(|e| e.to_string())?;
    let chapters = db.list_chapters(project_id).map_err(|e| e.to_string())?;
    if chapters.is_empty() {
        return Err("还没有章节，无法出整改方案".to_string());
    }
    let chapter_list = chapters
        .iter()
        .map(|c| format!("第{}章 {}", c.order_index, c.title))
        .collect::<Vec<_>>()
        .join("\n");

    let cfg = load_llm_config(&db);
    let raw = llm::chat_once(
        cfg,
        vec![
            (
                "system".to_string(),
                "你是网文责编，按一份总评报告制定整改方案。\
                只整改报告里点名的实质问题（情节逻辑/设定矛盾/节奏/文笔硬伤/AI味），\
                优点和风格特色不动。先输出方案说明（Markdown 列表，3~6 条：改什么、怎么改、\
                预期提升哪个维度分），然后另起一行输出标记 [FIX]，后跟 JSON：\
                {\"chapters\": [\"受影响章节名，从章节列表里原样选\"], \
                \"instruction\": \"给执行改写的 AI 的完整指令：整改目标 + 每章要点 + \
                保持不变的东西（主线/人设/风格），200字内\"}\
                没有值得动章节的问题就输出空 chapters 数组。"
                    .to_string(),
            ),
            (
                "user".to_string(),
                format!(
                    "【总评报告】\n{}\n\n【章节列表】\n{}",
                    head_chars(&report, 6000),
                    chapter_list
                ),
            ),
        ],
    )
    .await
    .map_err(|e| e.to_string())?;

    let plan = match raw.find("[FIX]") {
        Some(pos) => raw[..pos].trim().to_string(),
        None => raw.trim().to_string(),
    };
    #[derive(serde::Deserialize)]
    struct FixJson {
        chapters: Vec<String>,
        instruction: String,
    }
    let fix = raw
        .find("[FIX]")
        .and_then(|pos| raw[pos + 5..].find('{').map(|s| pos + 5 + s))
        .and_then(|start| raw[start..].rfind('}').map(|e| (start, e)))
        .and_then(|(s, e)| serde_json::from_str::<FixJson>(&raw[s..=e + 1]).ok())
        .ok_or("整改方案解析失败，请重试")?;

    // 章节名 → id（包含匹配，报告里的名字可能带卷名或简写）
    let mut picked: Vec<&db::ChapterMeta> = chapters
        .iter()
        .filter(|c| {
            fix.chapters.iter().any(|name| {
                let n = name.trim();
                !n.is_empty()
                    && (c.title.contains(n)
                        || n.contains(c.title.as_str())
                        || n.contains(&format!("第{}章", c.order_index)))
            })
        })
        .collect();
    picked.sort_by_key(|c| c.order_index);
    Ok(CheckFixPlan {
        plan,
        instruction: fix.instruction.trim().to_string(),
        chapter_ids: picked.iter().map(|c| c.id).collect(),
        chapter_titles: picked.iter().map(|c| c.title.clone()).collect(),
    })
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
    target_chapters: Option<i64>,
) -> Result<(), String> {
    db.save_outline_item(id, &title, &content, target_chapters.unwrap_or(0))
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

#[derive(Debug, Serialize, Deserialize)]
pub struct OutlineDraft {
    pub title: String,
    pub content: String,
    /// 按剧情体量预估的本卷章数（0 = 未估）
    #[serde(default)]
    pub target_chapters: i64,
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
                根据作品简介与设定，产出 5~8 个分卷/情节节点。\
                每个节点必须说清四件事：本卷目标、核心冲突、高潮兑现点、卷末局面变成什么；\
                节奏符合网文规律（开局危机压身、黄金三章立住追更理由、第一个高潮、中期升级、\
                后期爆发、结局预留）；阻力源要随卷升级，不靠解释撑看点。\
                每卷还要按剧情体量预估章数：冲突密度高、阶段目标重的卷长，过渡/开局卷短，\
                各卷章数应有多有少，绝不允许平均分。\
                只输出 JSON 数组：[{\"title\": \"节点名（如：卷一·惊蛰之变）\", \
                \"content\": \"本卷主线与关键转折，80字内\", \
                \"target_chapters\": 本卷预估章数（整数）}…]，\
                不要输出其他内容。"
                    .to_string(),
            ),
            (
                "user".to_string(),
                format!(
                    "【书名】《{}》\n【简介】\n{}\n\n【设定资料】\n{}\n\n【篇幅】{}\n\n（当前已有 {} 章正文）",
                    project.name,
                    if project.synopsis.is_empty() {
                        &project.description
                    } else {
                        &project.synopsis
                    },
                    if lore.is_empty() { "（暂无设定）" } else { &lore },
                    if project.target_total_words > 0 && project.target_chapter_words > 0 {
                        format!(
                            "全书目标 {} 字 / 每章约 {} 字（即全书约 {} 章），各卷预估章数请参照这个总量分配",
                            project.target_total_words,
                            project.target_chapter_words,
                            project.target_total_words / project.target_chapter_words
                        )
                    } else {
                        "未设字数目标，按网文常见体量估（每卷一般 20~60 章，全书 6~8 卷）".to_string()
                    },
                    chapter_count
                ),
            ),
        ],
    )
    .await
    .map_err(|e| e.to_string())?;

    let start = raw.find('[').ok_or("大纲结果不是 JSON 数组")?;
    let end = raw.rfind(']').ok_or("大纲结果不是 JSON 数组")?;
    let drafts: Vec<OutlineDraft> =
        serde_json::from_str(&raw[start..=end]).map_err(|e| format!("大纲 JSON 解析失败: {e}"))?;
    let items: Vec<(String, String, i64)> = drafts
        .into_iter()
        .map(|d| {
            (
                d.title.trim().to_string(),
                d.content.trim().to_string(),
                d.target_chapters.max(0),
            )
        })
        .filter(|(t, _, _)| !t.is_empty())
        .collect();
    if items.is_empty() {
        return Err("大纲结果为空，请重试".to_string());
    }
    db.replace_outline(project_id, &items)
        .map_err(|e| e.to_string())?;
    db.list_outline(project_id).map_err(|e| e.to_string())
}



// ---------- 对话式起书 ----------

const BOOTSTRAP_CHAT_SYSTEM: &str = "你是资深中文网文策划，深谙番茄/起点市场与读者口味。\
你在和用户通过多轮对话共创一部新书。\n\
【要弄清的事】（缺什么问什么，已在对话里说过的不要重复问）\n\
1. 题材与频道：男频/女频、具体类型（都市/仙侠/古言/悬疑…）\n\
2. 核心卖点与金手指：这本书最勾人的一点是什么\n\
3. 主角：谁、什么处境、什么性格\n\
4. 故事引擎与爽点类型：升级/复仇/甜宠/悬疑…读者追更追的是什么\n\
5. 篇幅目标：全书大概多少字、每章多少字（用户没概念就按题材给建议）\n\
【提问纪律】\n\
- 每轮最多问 1~2 个问题，挑信息缺口最大的问，绝不把一堆问题糊用户脸上\n\
- 用户说“直接生成”“你看着办”之类的话，或信息已够用（通常 2~4 轮）时，立刻出最终方案\n\
- 回答用户问题时顺带给出你的专业建议，别只做复读机\n\
【出最终方案的格式】（严格遵守）\n\
先输出一段话总结策划思路（卖点/故事引擎/前三章怎么抓人），然后另起一行输出标记 [DRAFT]，\
标记后紧跟一个 JSON 对象：\
{\"name\": \"番茄风书名（2~8字，平台向：钩子直给、有网感、一眼知道卖点）\", \
\"real_name\": \"真实书名（2~8字，有内涵：取核心意象/双关/点题不剧透，像正式出版的文学作品名，\
耐琢磨——不许套《XX系统》《重生之XX》这类模板，也别和番茄风书名同义重复）\", \
\"description\": \"题材+一句话卖点，20字内\", \"synopsis\": \"番茄风简介100~150字：第一句钩子、点出看点、结尾悬念；\
去AI味：钩子落在具体反常事件/细节上，不落抽象大词；禁排比、禁「这不是X而是Y」、\
禁「命运的齿轮」「一场关于XX的XX」类空话、不用仿佛/一丝/一抹等高频词\", \
\"target_total_words\": 全书目标字数（数字）, \"target_chapter_words\": 每章字数（数字，网文一般 2000~3000）, \
\"outline\": [{\"title\": \"阶段名（如：开局·立足异界 / 中期·文明碰撞）\", \"content\": \"这一步的阶段目标/主要冲突/阶段末局面变化，60字内\", \"target_chapters\": 本卷预估章数（整数）}…], \
\"lore\": [{\"category\": \"人物/世界观/地点/物品/伏笔/其他\", \"title\": \"词条名\", \
\"content\": \"设定内容\", \"keywords\": \"触发词,逗号分隔\", \"always_include\": true}…]}\
（lore 4~6 条，必含主角人物卡 always_include=true、核心对手、世界观、金手指；\
outline 是整本书的分步流程：开局→前期发展→中期转折→后期爆发→结局，6~10 步，\
第一步必须把黄金三章的抓人点排进去；\
target_chapters 按各卷剧情体量预估：冲突密度高、阶段目标重的卷章数多，开局/过渡卷少，\
各卷应有多有少，绝不允许平均分；全书总章数参照用户给的篇幅目标，没给就按网文常见体量）";


#[derive(Debug, Deserialize)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}


/// 对话式起书（流式版）：delta 实时推给前端，[DRAFT] 草稿由前端在 done 后解析
#[tauri::command]
pub async fn ai_bootstrap_chat_stream(
    db: State<'_, Db>,
    messages: Vec<ChatMsg>,
    channel: Channel<StreamEvent>,
) -> Result<(), String> {
    if messages.is_empty() {
        return Err("对话为空".to_string());
    }
    let cfg = load_llm_config(&db);
    let mut msgs: Vec<(String, String)> =
        vec![("system".to_string(), BOOTSTRAP_CHAT_SYSTEM.to_string())];
    for m in messages {
        let role = if m.role == "assistant" {
            "assistant"
        } else {
            "user"
        };
        msgs.push((role.to_string(), m.content));
    }
    llm::stream_chat(cfg, msgs, channel)
        .await
        .map_err(|e| e.to_string())
}

// ---------- 会话归档（起书向导 bootstrap / 风格对话 style 共用，按 scene 区分） ----------

fn normalize_scene(scene: Option<String>) -> String {
    match scene.as_deref().map(str::trim) {
        Some("style") => "style".to_string(),
        _ => "bootstrap".to_string(),
    }
}

/// 保存会话（id=None 新建），返回会话 id
#[tauri::command]
pub fn save_chat_session(
    db: State<'_, Db>,
    id: Option<i64>,
    title: String,
    messages: String,
    draft: String,
    scene: Option<String>,
) -> Result<i64, String> {
    db.save_chat_session(id, &title, &messages, &draft, &normalize_scene(scene))
        .map_err(|e| e.to_string())
}

/// 最近一条会话（按场景过滤，进入向导/风格对话恢复用）
#[tauri::command]
pub fn get_latest_chat_session(
    db: State<'_, Db>,
    scene: Option<String>,
) -> Result<Option<db::ChatSession>, String> {
    db.latest_chat_session(&normalize_scene(scene))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_chat_sessions(
    db: State<'_, Db>,
    scene: Option<String>,
) -> Result<Vec<db::ChatSession>, String> {
    db.list_chat_sessions(&normalize_scene(scene))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_chat_session(db: State<'_, Db>, id: i64) -> Result<(), String> {
    db.delete_chat_session(id).map_err(|e| e.to_string())
}

// ---------- 写作助手（悬浮窗） ----------

const ASSISTANT_SYSTEM: &str = "你是这本网文的责编助手，深度掌握本书的设定、剧情进度与大纲。\n\
铁律：回答必须基于给定资料——设定/摘要/大纲里没写的情节不要编造；\
答剧情问题时指明出处（哪一章）；给建议要具体可落地（用网文的卖点/钩子/节奏方法论），不说空话。\
回答用 Markdown，简洁有条理。";

/// 写作助手对话：注入全书上下文（设定 + 全部摘要 + 大纲 + 当前章尾部），流式回复
#[tauri::command]
pub async fn assistant_chat(
    db: State<'_, Db>,
    project_id: i64,
    chapter_id: Option<i64>,
    messages: Vec<ChatMsg>,
    channel: Channel<StreamEvent>,
) -> Result<(), String> {
    if messages.is_empty() {
        return Err("对话为空".to_string());
    }
    let cfg = load_llm_config(&db);

    // 当前章尾部（有打开的章节就带）
    let chapter_tail = match chapter_id.and_then(|id| db.get_chapter(id).ok()) {
        Some(c) if c.project_id == project_id => {
            tail_chars(&db::html_to_text(&c.content), CONTEXT_TAIL_CHARS)
        }
        _ => String::new(),
    };

    // 设定：常驻 + 关键词命中（匹配文本 = 最后一条用户消息 + 当前章尾部）
    let last_user = messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.as_str())
        .unwrap_or("");
    let entries = db.list_lore_entries(project_id).unwrap_or_default();
    let ledger = db
        .list_lore_changes(project_id, None, None)
        .unwrap_or_default();
    let (lore_section, injected) =
        build_lore_section(&entries, &format!("{last_user}\n{chapter_tail}"), &ledger);

    // 全部章节摘要（体检同款预算）
    let summaries = db
        .list_summaries_before(project_id, i64::MAX)
        .unwrap_or_default();
    let mut summary_section = String::new();
    for (title, summary) in &summaries {
        let line = format!("《{title}》{}\n", summary.trim());
        if summary_section.len() + line.len() > CHECK_SUMMARY_BUDGET {
            summary_section.push_str("……（更多摘要省略）\n");
            break;
        }
        summary_section.push_str(&line);
    }

    // 大纲
    let outline = db.list_outline(project_id).unwrap_or_default();
    let outline_counts = db.count_chapters_by_outline(project_id).unwrap_or_default();
    let outline_section = build_outline_section(&outline, &outline_counts);

    // 注入明细（可观测性）
    let mut notes = Vec::new();
    notes.push(if injected.is_empty() {
        "未注入设定".to_string()
    } else {
        format!("设定：{}", injected.join("、"))
    });
    notes.push(format!("摘要 {} 章", summaries.len()));
    if !outline.is_empty() {
        notes.push(format!("大纲 {} 节", outline.len()));
    }
    if chapter_id.is_some() {
        notes.push("当前章上下文".to_string());
    }
    let _ = channel.send(StreamEvent::Meta {
        note: notes.join("｜"),
    });

    let system = if lore_section.is_empty() {
        ASSISTANT_SYSTEM.to_string()
    } else {
        format!("{ASSISTANT_SYSTEM}\n\n【设定资料】\n{lore_section}")
    };

    // 上下文作为第一条 user 消息，后接对话历史
    let mut context = String::new();
    if !summary_section.is_empty() {
        context.push_str(&format!("【前情摘要】\n{summary_section}\n"));
    }
    if !outline_section.is_empty() {
        context.push_str(&format!("【全书大纲】\n{outline_section}\n"));
    }
    if !chapter_tail.is_empty() {
        context.push_str(&format!("【当前打开章节的结尾】\n{chapter_tail}\n"));
    }
    if context.is_empty() {
        context.push_str("（本书还没有正文，只有设定资料）\n");
    }
    context.push_str("以上是本书的资料，请基于它们回答。");

    let mut msgs: Vec<(String, String)> = vec![
        ("system".to_string(), system),
        ("user".to_string(), context),
    ];
    for m in messages {
        let role = if m.role == "assistant" {
            "assistant"
        } else {
            "user"
        };
        msgs.push((role.to_string(), m.content));
    }
    llm::stream_chat(cfg, msgs, channel)
        .await
        .map_err(|e| e.to_string())
}

const ASSISTANT_REWRITE_SYSTEM: &str = "你是中文网文编辑，按指令改写整章正文。\n\
保持设定、视角、人称与文风一致；保持与前后章的剧情连贯（前后章摘要已给出，不得与之矛盾）。\n\
语言硬要求：能用动作不用总结，能用对白不用解释，能写具体不写抽象；对白带身份感。\n\
去AI味硬约束：不用 仿佛/一丝/一抹/深吸一口气/眼中闪过/嘴角勾起/心中一动 等高频词；\
不写三连排比与「不是A，而是B」；情绪用动作外化不直接命名；结尾不总结升华。\
直接输出改写后的全章正文，不要章节标题、不要解释、不要元信息。";

/// 单章改写：流式输出改写后的全文（前端预览确认后才落库）
#[tauri::command]
pub async fn assistant_rewrite_chapter(
    db: State<'_, Db>,
    chapter_id: i64,
    instruction: String,
    channel: Channel<StreamEvent>,
) -> Result<(), String> {
    if instruction.trim().is_empty() {
        return Err("请先写改写要求".to_string());
    }
    let chapter = db.get_chapter(chapter_id).map_err(|e| e.to_string())?;
    let user = build_rewrite_user(&db, &chapter, &instruction)?;
    let cfg = load_llm_config(&db);

    let before = db
        .list_summaries_before(chapter.project_id, chapter.order_index)
        .unwrap_or_default();
    let after = db
        .list_summaries_after(chapter.project_id, chapter.order_index)
        .unwrap_or_default();
    let _ = channel.send(StreamEvent::Meta {
        note: format!(
            "改写《{}》｜前情摘要 {} 章｜后续摘要 {} 章",
            chapter.title,
            before.len(),
            after.len()
        ),
    });

    llm::stream_chat(
        cfg,
        vec![
            ("system".to_string(), ASSISTANT_REWRITE_SYSTEM.to_string()),
            ("user".to_string(), user),
        ],
        channel,
    )
    .await
    .map_err(|e| e.to_string())
}

/// 改写 user 消息：前后章摘要 + 改写要求 + 全章原文（单章/批量共用）
fn build_rewrite_user(db: &Db, chapter: &Chapter, instruction: &str) -> Result<String, String> {
    let plain = db::html_to_text(&chapter.content);
    if plain.trim().is_empty() {
        return Err(format!("《{}》还没有内容", chapter.title));
    }
    // 全章改写必须看到全文：超长章引导用划词分段改
    if plain.chars().count() > 8000 {
        return Err(format!(
            "《{}》超过 8000 字，整章改写会丢失细节，建议划词分段处理",
            chapter.title
        ));
    }
    let before = db
        .list_summaries_before(chapter.project_id, chapter.order_index)
        .unwrap_or_default();
    let after = db
        .list_summaries_after(chapter.project_id, chapter.order_index)
        .unwrap_or_default();
    let before_text = before
        .iter()
        .map(|(t, s)| format!("《{t}》{}", s.trim()))
        .collect::<Vec<_>>()
        .join("\n");
    let after_text = after
        .iter()
        .map(|(t, s)| format!("《{t}》{}", s.trim()))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(format!(
        "{}{}【改写要求】\n{}\n\n【《{}》原文】\n{}",
        if before_text.is_empty() {
            String::new()
        } else {
            format!("【前文摘要】\n{before_text}\n\n")
        },
        if after_text.is_empty() {
            String::new()
        } else {
            format!("【后续章节摘要】（改写不得与之矛盾）\n{after_text}\n\n")
        },
        instruction.trim(),
        chapter.title,
        plain
    ))
}

// ---------- 跨章改写（范围定位 → 确认 → 队列跑批 → 可回滚） ----------

#[derive(Debug, Serialize)]
pub struct ScopeItem {
    pub chapter_id: i64,
    pub title: String,
    pub reason: String,
}

/// LLM 按摘要链定位受改写指令影响的章节
#[tauri::command]
pub async fn locate_rewrite_scope(
    db: State<'_, Db>,
    project_id: i64,
    instruction: String,
) -> Result<Vec<ScopeItem>, String> {
    if instruction.trim().is_empty() {
        return Err("请先写改写要求".to_string());
    }
    let summaries = db
        .list_summaries_with_id(project_id)
        .map_err(|e| e.to_string())?;
    if summaries.is_empty() {
        return Err("还没有章节摘要，先在体检页补齐摘要".to_string());
    }
    let mut section = String::new();
    for (id, title, summary) in &summaries {
        let line = format!("[{id}]《{title}》{}\n", summary.trim());
        if section.len() + line.len() > CHECK_SUMMARY_BUDGET {
            section.push_str("……（更多摘要省略）\n");
            break;
        }
        section.push_str(&line);
    }
    let cfg = load_llm_config(&db);
    let raw = llm::chat_once(
        cfg,
        vec![
            (
                "system".to_string(),
                "你是小说责编。用户要对全书做一次批量改写。根据各章摘要，判断哪些章节需要改动。\
                只输出 JSON 数组：[{\"chapter_id\": 章节id（数字）, \"reason\": \"为什么需要改，20字内\"}…]。\
                只收真正受影响的章节，宁缺毋滥；没有受影响的就输出 []。不要输出其他内容。"
                    .to_string(),
            ),
            (
                "user".to_string(),
                format!("【改写要求】\n{}\n\n【各章摘要】\n{}", instruction.trim(), section),
            ),
        ],
    )
    .await
    .map_err(|e| e.to_string())?;

    let start = raw.find('[').ok_or("定位结果不是 JSON 数组")?;
    let end = raw.rfind(']').ok_or("定位结果不是 JSON 数组")?;
    #[derive(Deserialize)]
    struct RawItem {
        chapter_id: i64,
        reason: String,
    }
    let raw_items: Vec<RawItem> =
        serde_json::from_str(&raw[start..=end]).map_err(|e| format!("定位结果解析失败: {e}"))?;
    let title_of = |cid: i64| {
        summaries
            .iter()
            .find(|(id, _, _)| *id == cid)
            .map(|(_, t, _)| t.clone())
    };
    Ok(raw_items
        .into_iter()
        .filter_map(|r| {
            title_of(r.chapter_id).map(|title| ScopeItem {
                chapter_id: r.chapter_id,
                title,
                reason: r.reason,
            })
        })
        .collect())
}

/// 跨章改写执行器（任务队列 kind = rewrite_chapters）：
/// 每章先快照（可回滚），再整章改写落库并重生成摘要（摘要链不断）
pub(crate) async fn run_rewrite_chapters(db: &Db, task: &Task) -> Result<TaskEnd, String> {
    #[derive(Deserialize)]
    struct Payload {
        chapter_ids: Vec<i64>,
        instruction: String,
    }
    let payload: Payload =
        serde_json::from_str(&task.payload).map_err(|e| format!("任务参数解析失败: {e}"))?;
    let total = payload.chapter_ids.len() as i64;
    if total == 0 {
        return Err("没有要改写的章节".to_string());
    }
    let cfg = load_llm_config(db);
    let mut done = 0i64;
    let mut skipped: Vec<String> = Vec::new();

    for (i, cid) in payload.chapter_ids.iter().enumerate() {
        if crate::tasks::is_cancel_requested(task.id) {
            return Ok(TaskEnd::Cancelled(format!(
                "已改写 {done} 章（已取消，快照可回滚）"
            )));
        }
        let chapter = db.get_chapter(*cid).map_err(|e| e.to_string())?;
        let _ = db.update_task_progress(task.id, i as i64, total, &chapter.title);

        // 先快照，再改写——回滚的数据基础
        db.backup_chapter(task.id, *cid)
            .map_err(|e| e.to_string())?;

        let user = match build_rewrite_user(db, &chapter, &payload.instruction) {
            Ok(u) => u,
            Err(e) => {
                skipped.push(format!("《{}》（{e}）", chapter.title));
                continue;
            }
        };
        let text = llm::chat_once(
            cfg.clone(),
            vec![
                ("system".to_string(), ASSISTANT_REWRITE_SYSTEM.to_string()),
                ("user".to_string(), user),
            ],
        )
        .await
        .map_err(|e| format!("《{}》改写失败（已完成 {done} 章）: {e}", chapter.title))?;

        db.save_chapter(*cid, &chapter.title, &text_to_html(&text))
            .map_err(|e| e.to_string())?;
        // 摘要联动：改写后重生成，保证后续章节的摘要链不断
        let plain = db::html_to_text(&text_to_html(&text));
        if let Ok(summary) = summarize_chapter_text(&cfg, &chapter.title, &plain).await {
            let _ = db.save_summary(*cid, &summary);
        }
        done += 1;
    }

    let mut msg = format!("已改写 {done} 章");
    if !skipped.is_empty() {
        msg.push_str(&format!(
            "，跳过 {} 章（{}）",
            skipped.len(),
            skipped.join("、")
        ));
    }
    msg.push_str("，快照已存，可在任务面板回滚");
    let _ = db.update_task_progress(task.id, done, total, "完成");
    Ok(TaskEnd::Done(msg))
}

/// 回滚：把任务快照的章节恢复到改写前状态
#[tauri::command]
pub fn rollback_rewrite_task(db: State<'_, Db>, task_id: i64) -> Result<String, String> {
    let backups = db.list_backups(task_id).map_err(|e| e.to_string())?;
    if backups.is_empty() {
        return Err("该任务没有可回滚的快照".to_string());
    }
    let n = backups.len();
    for (chapter_id, title, content, summary) in &backups {
        db.save_chapter(*chapter_id, title, content)
            .map_err(|e| e.to_string())?;
        db.save_summary(*chapter_id, summary)
            .map_err(|e| e.to_string())?;
    }
    db.delete_backups(task_id).map_err(|e| e.to_string())?;
    Ok(format!("已回滚 {n} 章到改写前状态"))
}

// ---------- 合规扫描（敏感词，纯文本检索不调 LLM） ----------

#[derive(Debug, Serialize)]
pub struct ScanHit {
    pub chapter_id: i64,
    pub title: String,
    pub word: String,
    pub context: String,
}

/// 扫描结果：命中清单 + 全书总字数（前端算 AI 味密度用）
#[derive(Debug, Serialize)]
pub struct ScanResult {
    pub hits: Vec<ScanHit>,
    pub total_words: i64,
}

#[tauri::command]
pub fn scan_banned_words(
    db: State<'_, Db>,
    project_id: i64,
    words: Vec<String>,
) -> Result<ScanResult, String> {
    let words: Vec<String> = words
        .into_iter()
        .map(|w| w.trim().to_string())
        .filter(|w| !w.is_empty())
        .collect();
    if words.is_empty() {
        return Err("请先填要扫描的敏感词".to_string());
    }
    let bodies = db
        .list_chapter_bodies(project_id)
        .map_err(|e| e.to_string())?;
    // 需要 chapter_id，改用 chapters 全量查询
    let metas = db.list_chapters(project_id).map_err(|e| e.to_string())?;
    let mut hits = Vec::new();
    let mut total_words = 0i64;
    for (m, (_, content_html)) in metas.iter().zip(bodies.iter()) {
        let plain = db::html_to_text(content_html);
        total_words += plain.chars().count() as i64;
        let chars: Vec<char> = plain.chars().collect();
        for w in &words {
            let mut from = 0usize;
            while let Some(pos) = plain.get(from..).and_then(|s| s.find(w.as_str())) {
                let abs = from + pos;
                // 前后各取 20 字当上下文
                let char_pos = plain[..abs].chars().count();
                let start = char_pos.saturating_sub(20);
                let end = (char_pos + w.chars().count() + 20).min(chars.len());
                let ctx: String = chars[start..end].iter().collect();
                hits.push(ScanHit {
                    chapter_id: m.id,
                    title: m.title.clone(),
                    word: w.clone(),
                    context: format!("…{}…", ctx.replace('\n', " ")),
                });
                if hits.len() >= 200 {
                    return Ok(ScanResult { hits, total_words }); // 防爆：最多 200 条
                }
                from = abs + w.len();
            }
        }
    }
    Ok(ScanResult { hits, total_words })
}

const COLLECT_LORE_SYSTEM: &str = "你是小说设定整理员。通读章节梗概，搜集对创作和视觉化有用的设定条目：
【人物】出场的重要角色：身份、外貌特征（长相/穿着/标志物）、性格、能力
【地点】重要场景：环境布局、光线氛围、地标
【物品】关键道具：外观形制、功能、来历
【世界观】势力/规则/体系（确有必要才建，不超过 2 条）
要求：
- 「已登记词条」里已有的不要重复搜集；
- 每条 content 不超过 150 字，必须包含外观/视觉细节（后续要据此生成设定图）；
- keywords 给 1~3 个称呼/别名，逗号分隔；
- category 只能是：人物 / 地点 / 物品 / 世界观 / 其他；
- 只输出 JSON 数组：[{\"title\":\"\",\"category\":\"\",\"content\":\"\",\"keywords\":\"\"}…]，不要输出任何其他内容。";

/// AI 搜集设定：读全书摘要链（缺摘要的章补正文头部），提取人物/地点/物品等词条入库。
/// 素材预算 8000 字（体检同规格）；已登记的标题跳过不重复
#[tauri::command]
pub async fn collect_lore_entries(db: State<'_, Db>, project_id: i64) -> Result<String, String> {
    const BUDGET: usize = 8000;
    let mut material = String::new();
    for (_, title, summary) in db
        .list_summaries_with_id(project_id)
        .map_err(|e| e.to_string())?
    {
        material.push_str(&format!("《{title}》{summary}
"));
    }
    for ch in db
        .list_chapters_missing_summary(project_id)
        .map_err(|e| e.to_string())?
    {
        let plain = crate::db::html_to_text(&ch.content);
        let head: String = plain.chars().take(300).collect();
        if !head.trim().is_empty() {
            material.push_str(&format!("《{}》（节选）{}
", ch.title, head));
        }
    }
    if material.trim().is_empty() {
        return Err("还没有正文内容，先写几章再来搜集".to_string());
    }
    if material.chars().count() > BUDGET {
        material = material.chars().take(BUDGET).collect();
    }

    let existing = db.list_lore_entries(project_id).unwrap_or_default();
    let existing_titles: Vec<String> = existing
        .iter()
        .map(|e| e.title.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();

    let cfg = load_llm_config(&db);
    let raw = llm::chat_once(
        cfg,
        vec![
            ("system".to_string(), COLLECT_LORE_SYSTEM.to_string()),
            (
                "user".to_string(),
                format!(
                    "【已登记词条】
{}

【章节梗概】
{}",
                    if existing_titles.is_empty() {
                        "（无）".to_string()
                    } else {
                        existing_titles.join("、")
                    },
                    material
                ),
            ),
        ],
    )
    .await
    .map_err(|e| e.to_string())?;

    #[derive(serde::Deserialize)]
    struct Draft {
        title: String,
        category: String,
        content: String,
        keywords: String,
    }
    let start = raw.find('[').ok_or("搜集结果不是 JSON 数组")?;
    let end = raw.rfind(']').ok_or("搜集结果不是 JSON 数组")?;
    let drafts: Vec<Draft> = serde_json::from_str(&raw[start..=end])
        .map_err(|e| format!("搜集结果解析失败: {e}"))?;

    const VALID: [&str; 5] = ["人物", "地点", "物品", "世界观", "其他"];
    let mut created = 0usize;
    let mut per_cat: std::collections::HashMap<String, usize> = Default::default();
    for d in drafts.into_iter().take(20) {
        let title = d.title.trim();
        if title.is_empty() || existing_titles.iter().any(|t| t == title) {
            continue;
        }
        let category = if VALID.contains(&d.category.trim()) {
            d.category.trim()
        } else {
            "其他"
        };
        let e = db
            .create_lore_entry(project_id, title, category)
            .map_err(|e| e.to_string())?;
        db.update_lore_entry(&crate::db::LoreEntry {
            content: d.content.trim().to_string(),
            keywords: d.keywords.trim().to_string(),
            ..e
        })
        .map_err(|e| e.to_string())?;
        *per_cat.entry(category.to_string()).or_default() += 1;
        created += 1;
    }
    if created == 0 {
        return Ok("没有发现新设定（已有的都登记过了）".to_string());
    }
    let breakdown = per_cat
        .iter()
        .map(|(c, n)| format!("{c}×{n}"))
        .collect::<Vec<_>>()
        .join(" ");
    Ok(format!("新搜集 {created} 条：{breakdown}"))
}

/// 穷尽式设定收集：逐章跑三段提取（变更 + 实体 + 关系），一次补齐整本书的设定图鉴、
/// 关系网络与台账——W2 提取升级后与「补齐全部章节」同源，这里做成带进度的一键全书版。
/// 新词条 keywords=标题非常驻（词条多不伤注入预算）；已有词条不动，关系/台账整章替换幂等
#[tauri::command]
pub async fn collect_lore_exhaustive(
    db: State<'_, Db>,
    project_id: i64,
    channel: Channel<ProgressEvent>,
) -> Result<String, String> {
    let cfg = load_llm_config(&db);
    let metas = db.list_chapters(project_id).map_err(|e| e.to_string())?;
    let targets: Vec<&db::ChapterMeta> = metas
        .iter()
        .filter(|m| m.word_count > 0)
        .collect();
    if targets.is_empty() {
        return Err("还没有正文内容，先写几章再来搜集".to_string());
    }

    let total = targets.len() as i64;
    let mut sum = ExtractOutcome::default();
    for (i, m) in targets.iter().enumerate() {
        let _ = channel.send(ProgressEvent::Progress {
            current: i as i64 + 1,
            total,
            label: format!(
                "{}（词条 +{} · 关系 +{}）",
                m.title, sum.entities, sum.relations
            ),
        });
        // 复用三段提取（与写章后的自动链路同一份 prompt，结果一致）：单章失败跳过不中断
        match extract_chapter_lore_changes(&db, &cfg, m.id).await {
            Ok(o) => {
                sum.changes += o.changes;
                sum.entities += o.entities;
                sum.relations += o.relations;
            }
            Err(e) => eprintln!("《{}》穷尽收集失败（继续下一章）: {e}", m.title),
        }
    }
    let _ = channel.send(ProgressEvent::Done);
    Ok(format!(
        "全书扫描 {} 章完成：新增词条 {} · 关系 {} · 变更 {}（变更在台账页可应用到设定库）",
        total, sum.entities, sum.relations, sum.changes
    ))
}
