//! 写作风格库：本地文本样本 → LLM 蒸馏风格卡
//!
//! 样本由用户上传 txt 或粘贴文本（前端 FileReader 读入），仅用于本地风格分析，
//! UI 已提示建议使用公版/免费授权作品。

use crate::commands::load_llm_config;
use crate::db::{Db, Style};
use crate::llm;
use tauri::State;

/// 蒸馏时喂给 LLM 的样本上限（头 6000 + 中 3000 + 尾 3000）
const DISTILL_INPUT_CHARS: usize = 12000;

/// 蒸馏风格：样本分三段取样 → LLM 出结构化风格卡 → 入库
#[tauri::command]
pub async fn distill_style(
    db: State<'_, Db>,
    name: String,
    source: String,
    sample_text: String,
) -> Result<Style, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("请给风格起个名字".to_string());
    }
    let sample = sample_text.trim().to_string();
    if sample.chars().count() < 500 {
        return Err("样本太短（至少 500 字），风格特征分析不出来".to_string());
    }

    // 头/中/尾三段取样：风格贯穿全文，只看开头容易以偏概全
    let chars: Vec<char> = sample.chars().collect();
    let excerpt = if chars.len() <= DISTILL_INPUT_CHARS {
        sample.clone()
    } else {
        let head_len = DISTILL_INPUT_CHARS / 2; // 头 6000
        let mid_len = DISTILL_INPUT_CHARS / 4; // 中 3000
        let tail_len = DISTILL_INPUT_CHARS / 4; // 尾 3000
        let head: String = chars[..head_len].iter().collect();
        let mid_start = chars.len() / 2;
        let mid: String = chars[mid_start..(mid_start + mid_len).min(chars.len())]
            .iter()
            .collect();
        let tail: String = chars[chars.len() - tail_len..].iter().collect();
        format!("{head}\n……（节选）……\n{mid}\n……（节选）……\n{tail}")
    };

    let cfg = load_llm_config(&db);
    let guide = llm::chat_once(
        cfg,
        vec![
            (
                "system".to_string(),
                "你是文学风格分析师。阅读给定的小说样本，提炼出可执行的写作风格卡，\
                供另一位作者模仿该风格创作。按以下六个小节输出，每节一两句，总共不超过 400 字：\n\
                【整体基调】题材气质与情感基调\n\
                【句式与节奏】句长偏好、长短句搭配、叙事流速\n\
                【用词偏好】词汇质感（华丽/白描/口语化）、标志性表达\n\
                【叙事视角】人称、视角距离、心理描写占比\n\
                【对话风格】对话占比、说话方式、潜台词习惯\n\
                【钩子与爽点】章末钩子类型、情绪调动手法\n\
                只输出风格卡本身，不要复述剧情、不要提及具体角色名和书名。"
                    .to_string(),
            ),
            ("user".to_string(), format!("【小说样本】\n{excerpt}")),
        ],
    )
    .await
    .map_err(|e| e.to_string())?;

    // 示例片段由程序截取（不让 LLM 引用原文，防幻觉）：取 1/3 处的 ~150 字
    let ex_start = chars.len() / 3;
    let example: String = chars[ex_start..(ex_start + 150).min(chars.len())]
        .iter()
        .collect();

    db.create_style(
        &name,
        source.trim(),
        sample.chars().count() as i64,
        guide.trim(),
        example.trim(),
        "text",
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_styles(db: State<'_, Db>) -> Result<Vec<Style>, String> {
    db.list_styles().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_style(db: State<'_, Db>, id: i64) -> Result<(), String> {
    db.delete_style(id).map_err(|e| e.to_string())
}

/// 给作品指定/清除写作风格（style_id = 0 清除）
#[tauri::command]
pub fn set_project_style(db: State<'_, Db>, project_id: i64, style_id: i64) -> Result<(), String> {
    db.set_project_style(project_id, style_id)
        .map_err(|e| e.to_string())
}

const STYLE_CARD_SYSTEM: &str = "你是文学风格分析师兼作家。按用户的描述产出一张网文写作风格卡。\
描述里提到具体作家/作品时，凭你的知识概括其公开可见的风格特征，绝不复述或模仿原文句子。\
按六个小节输出，每节一两句，总共不超过 400 字：\n\
【整体基调】【句式与节奏】【用词偏好】【叙事视角】【对话风格】【钩子与爽点】\n\
只输出风格卡本身，不要解释。";

/// 图片画风卡：产出可直接注入生图 prompt 的画风锚点词
const IMAGE_CARD_SYSTEM: &str = "你是 AI 绘画提示词专家。按用户的描述产出一组画风锚点词，\
用于注入文生图 prompt 统一全片画风。\
要求：只写风格/质感/光影/色调/构图类词语（如「日系赛璐璐，干净平涂，柔和光影」），\
不写任何具体人物/场景内容；总长度 60 字以内；可用「杜绝 XX 感」类否定词。\
只输出锚点词本身，不要解释、不要序号。";

/// 视频运镜卡：产出可注入图生视频运动 prompt 的运镜锚点词
const VIDEO_CARD_SYSTEM: &str = "你是视频分镜导演。按用户的描述产出一组运镜锚点词，\
用于注入图生视频的运动提示词。\
要求：描述镜头运动方式与幅度（如「手持镜头，保持极其微弱、类似呼吸般的浮动」），\
收敛运动幅度（极缓/轻微类限定词），不写画面内容；总长度 40 字以内。\
只输出锚点词本身，不要解释、不要序号。";

/// 对话生成风格卡：纯描述出卡；带 previous_guide + tweak 时是微调（输出调整后的完整卡）。
/// kind = text（默认，写作风格卡）/ image（画风锚点词）/ video（运镜锚点词）
#[tauri::command]
pub async fn generate_style_card(
    db: State<'_, Db>,
    guidance: String,
    previous_guide: Option<String>,
    tweak: Option<String>,
    kind: Option<String>,
) -> Result<String, String> {
    let cfg = load_llm_config(&db);
    let system = match kind.as_deref().map(str::trim) {
        Some("image") => IMAGE_CARD_SYSTEM,
        Some("video") => VIDEO_CARD_SYSTEM,
        _ => STYLE_CARD_SYSTEM,
    };
    let user = match (previous_guide, tweak) {
        (Some(prev), Some(tw)) if !prev.trim().is_empty() && !tw.trim().is_empty() => format!(
            "【已有风格卡】\n{}\n\n【调整要求】\n{}\n\n输出调整后的完整风格卡（格式不变）。",
            prev.trim(),
            tw.trim()
        ),
        _ => format!("【风格描述】\n{}", guidance.trim()),
    };
    llm::chat_once(
        cfg,
        vec![
            ("system".to_string(), system.to_string()),
            ("user".to_string(), user),
        ],
    )
    .await
    .map_err(|e| e.to_string())
}

/// 保存风格卡（对话生成的写作风格，或前端内置预设一键添加的图片/视频风格）
#[tauri::command]
pub fn save_style_card(
    db: State<'_, Db>,
    name: String,
    source: String,
    guide: String,
    kind: Option<String>,
) -> Result<Style, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("请给风格起个名字".to_string());
    }
    if guide.trim().is_empty() {
        return Err("风格卡内容为空".to_string());
    }
    let kind = match kind.as_deref().map(str::trim) {
        Some("image") => "image",
        Some("video") => "video",
        _ => "text",
    };
    db.create_style(&name, source.trim(), 0, guide.trim(), "", kind)
        .map_err(|e| e.to_string())
}
