//! 写作风格库：本地文本样本 → LLM 蒸馏风格卡
//!
//! 样本由用户上传 txt（后端直接读文件，不经过前端展示——几百万字的书展示无意义）
//! 或粘贴文本，仅用于本地风格分析，UI 已提示建议使用公版/免费授权作品。

use crate::commands::{load_llm_config, ChatMsg};
use crate::db::{Db, Style};
use crate::llm;
use crate::llm::StreamEvent;
use tauri::ipc::Channel;
use tauri::State;

/// 蒸馏时喂给 LLM 的样本上限（头 6000 + 中 3000 + 尾 3000）
const DISTILL_INPUT_CHARS: usize = 12000;

/// 蒸馏核心：头/中/尾三段取样 → LLM 出风格卡 → 入库
async fn distill_and_save(
    db: &Db,
    name: &str,
    source: &str,
    sample: &str,
) -> Result<Style, String> {
    if name.trim().is_empty() {
        return Err("请给风格起个名字".to_string());
    }
    if sample.chars().count() < 500 {
        return Err("样本太短（至少 500 字），风格特征分析不出来".to_string());
    }

    // 头/中/尾三段取样：风格贯穿全文，只看开头容易以偏概全
    let chars: Vec<char> = sample.chars().collect();
    let excerpt = if chars.len() <= DISTILL_INPUT_CHARS {
        sample.to_string()
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

    let cfg = load_llm_config(db);
    let guide = llm::chat_once(
        cfg,
        vec![
            (
                "system".to_string(),
                "你是文学风格分析师。阅读给定的小说样本，只提炼文笔层面可模仿的特征——\
                题材、基调、钩子与爽点由作者写书时按简介大纲自定，不属于风格卡，绝不写进卡。\
                按以下五个小节输出，每节一两句，总共不超过 400 字：\n\
                【句式与节奏】句长偏好、长短句搭配、叙事流速\n\
                【用词偏好】词汇质感（华丽/白描/口语化）、标志性表达\n\
                【叙事视角】人称、视角距离、心理描写占比\n\
                【对话风格】对话占比、说话方式、潜台词习惯\n\
                【画面与细节】具象描写密度、五感细节、比喻习惯\n\
                只输出风格卡本身，不要复述剧情、不要提及具体角色名和书名，忽略题材与情节内容。"
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
        name.trim(),
        source.trim(),
        sample.chars().count() as i64,
        guide.trim(),
        example.trim(),
        "text",
    )
    .map_err(|e| e.to_string())
}

/// 蒸馏风格：样本分三段取样 → LLM 出结构化风格卡 → 入库
#[tauri::command]
pub async fn distill_style(
    db: State<'_, Db>,
    name: String,
    source: String,
    sample_text: String,
) -> Result<Style, String> {
    let sample = sample_text.trim().to_string();
    distill_and_save(&db, &name, &source, &sample).await
}

/// 上传 txt 蒸馏：后端直接读文件（几百万字的书不进前端），编码 UTF-8 → GB18030 回退
#[tauri::command]
pub async fn distill_style_from_file(
    db: State<'_, Db>,
    name: String,
    path: String,
) -> Result<Style, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    let sample = crate::book_import::decode_text(&bytes).trim().to_string();
    let file_name = std::path::Path::new(&path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("本地文件");
    let source = format!("本地文件：{file_name}");
    distill_and_save(&db, &name, &source, &sample).await
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

// ---------- 对话式风格定制（流式多轮，[CARD] 标记出卡） ----------

/// 对话底座：提问纪律 + 出卡格式，三类页签共用，卡规格按 kind 拼
const STYLE_CHAT_BASE: &str = "你在和用户通过多轮对话共创一张风格卡。\
【提问纪律】\n\
- 每轮最多问 1~2 个问题，挑信息缺口最大的问，绝不把一堆问题糊用户脸上\n\
- 用户说“直接生成”“你看着办”之类的话，或信息已够用（通常 1~3 轮）时，立刻出卡\n\
- 回答时顺带给出你的专业建议，别只做复读机\n\
【出卡格式】（严格遵守）\n\
先输出一段话说明这张卡的要点，然后另起一行输出标记 [CARD]，标记后紧跟完整风格卡。\
用户提调整意见后，重新输出调整后的完整卡（仍带 [CARD] 标记）。\
未出卡时正常对话，绝不输出标记。\n\
【卡的规格】\n";

/// 写作风格卡规格（沿用蒸馏卡的五节结构——纯文笔特征；题材/基调/钩子由作者写书时自定）
const STYLE_CHAT_SPEC_TEXT: &str = "按五个小节输出，每节一两句，总共不超过 400 字：\n\
【句式与节奏】【用词偏好】【叙事视角】【对话风格】【画面与细节】\n\
只描述文笔层面可模仿的特征，题材、基调、钩子与爽点不写进卡。\n\
描述里提到具体作家/作品时，凭你的知识概括其公开可见的风格特征，绝不复述或模仿原文句子。";

/// 图片画风卡规格（锚点词约束同一次性出卡时代的图片卡规格）
const STYLE_CHAT_SPEC_IMAGE: &str = "只写风格/质感/光影/色调/构图类词语（如「日系赛璐璐，干净平涂，柔和光影」），\
不写任何具体人物/场景内容；总长度 60 字以内；可用「杜绝 XX 感」类否定词。";

/// 视频运镜卡规格（收敛约束同一次性出卡时代的视频卡规格）
const STYLE_CHAT_SPEC_VIDEO: &str = "描述镜头运动方式与幅度（如「手持镜头，保持极其微弱、类似呼吸般的浮动」），\
收敛运动幅度（极缓/轻微类限定词），不写画面内容；总长度 40 字以内。";

/// 对话式风格定制（流式）：多轮问答 → [CARD] 出卡 → 继续对话微调（重新出整卡）。
/// kind = text（默认）/ image / video；[CARD] 后的卡内容由前端在 done 后解析。
/// base_card 有值时是「优化现有风格」模式：现有卡作为上下文垫在对话最前（不进 UI 气泡）。
#[tauri::command]
pub async fn generate_style_card_stream(
    db: State<'_, Db>,
    messages: Vec<ChatMsg>,
    kind: Option<String>,
    base_card: Option<String>,
    channel: Channel<StreamEvent>,
) -> Result<(), String> {
    if messages.is_empty() {
        return Err("对话为空".to_string());
    }
    let (persona, spec) = match kind.as_deref().map(str::trim) {
        Some("image") => ("你是 AI 绘画提示词专家。", STYLE_CHAT_SPEC_IMAGE),
        Some("video") => ("你是视频分镜导演。", STYLE_CHAT_SPEC_VIDEO),
        _ => ("你是文学风格分析师兼作家。", STYLE_CHAT_SPEC_TEXT),
    };
    let cfg = load_llm_config(&db);
    let mut msgs: Vec<(String, String)> = vec![(
        "system".to_string(),
        format!("{persona}{STYLE_CHAT_BASE}{spec}"),
    )];
    if let Some(base) = base_card.filter(|b| !b.trim().is_empty()) {
        msgs.push((
            "user".to_string(),
            format!(
                "【现有风格卡】\n{}\n\n我想在这张卡的基础上调整优化。",
                base.trim()
            ),
        ));
        msgs.push((
            "assistant".to_string(),
            "好的，当前风格卡我收到了。告诉我想怎么改，每次调整我都会输出完整的新卡（带 [CARD] 标记）。"
                .to_string(),
        ));
    }
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

/// 更新现有风格卡（对话优化后保存修改：只动名称与卡内容）
#[tauri::command]
pub fn update_style(db: State<'_, Db>, id: i64, name: String, guide: String) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("请给风格起个名字".to_string());
    }
    if guide.trim().is_empty() {
        return Err("风格卡内容为空".to_string());
    }
    db.update_style(id, name.trim(), guide.trim())
        .map_err(|e| e.to_string())
}
