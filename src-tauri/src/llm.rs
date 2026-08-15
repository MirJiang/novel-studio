//! LLM 接入层：OpenAI 兼容协议的流式客户端
//!
//! DeepSeek / 通义 / Kimi / 智谱 / OpenAI 都兼容这套协议，
//! 后续要加 Claude 等非兼容协议时，在这里加新的 provider 实现即可。

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

/// 推送给前端的流式事件（serde tag 序列化为 { type: "delta" | "done" | "error" | "meta", ... }）
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    /// 本次生成的元信息（如注入了哪些设定），在 delta 之前发送
    Meta { note: String },
    Delta { text: String },
    Done,
    Error { message: String },
}

#[derive(Debug, Clone)]
pub struct LlmConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    stream: bool,
    temperature: f32,
    /// 输出上限；None 时字段不下发（各家默认值不同）
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    /// 关闭思考模式：思考型模型（如 deepseek-v4-flash）会把 token 预算耗在
    /// reasoning 上导致正文为空，且显著拖慢速度；写作链路不需要它
    ///（OpenAI 兼容服务端对未知字段普遍忽略，不影响非思考型模型）
    thinking: Thinking,
}

#[derive(Serialize)]
struct Thinking {
    r#type: &'static str,
}

const THINKING_DISABLED: Thinking = Thinking { r#type: "disabled" };

#[derive(Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct ChatChunk {
    choices: Vec<ChunkChoice>,
}

#[derive(Deserialize)]
struct ChunkChoice {
    delta: ChunkDelta,
}

#[derive(Deserialize)]
struct ChunkDelta {
    content: Option<String>,
}

/// 流式对话：把 delta 通过 Channel 实时推给前端，出错也会以 Error 事件通知
pub async fn stream_chat(
    cfg: LlmConfig,
    messages: Vec<(String, String)>,
    channel: Channel<StreamEvent>,
) -> Result<()> {
    if cfg.api_key.trim().is_empty() {
        let _ = channel.send(StreamEvent::Error {
            message: "尚未配置 LLM API Key，请先在设置中填写".into(),
        });
        return Ok(());
    }

    let url = format!(
        "{}/chat/completions",
        cfg.base_url.trim_end_matches('/')
    );
    let body = ChatRequest {
        model: cfg.model.clone(),
        messages: messages
            .into_iter()
            .map(|(role, content)| ChatMessage { role, content })
            .collect(),
        stream: true,
        temperature: 0.8,
        max_tokens: None,
        thinking: THINKING_DISABLED,
    };

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .await
        .context("请求 LLM 接口失败")?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let _ = channel.send(StreamEvent::Error {
            message: format!("LLM 接口返回 {status}: {}", truncate(&text, 300)),
        });
        return Ok(());
    }

    // 解析 SSE：按行读取，处理 "data: {...}" 行，跨包缓冲
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();

    while let Some(item) = stream.next().await {
        let bytes = match item {
            Ok(b) => b,
            Err(e) => {
                let _ = channel.send(StreamEvent::Error {
                    message: format!("读取流失败: {e}"),
                });
                return Ok(());
            }
        };
        buf.push_str(&String::from_utf8_lossy(&bytes));

        // 每次只处理完整的行，残留的半行留到下次
        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim_end_matches('\r').to_string();
            buf.drain(..=pos);
            if handle_sse_line(&line, &channel)? {
                let _ = channel.send(StreamEvent::Done);
                return Ok(());
            }
        }
    }

    let _ = channel.send(StreamEvent::Done);
    Ok(())
}

/// 处理一行 SSE；返回 true 表示流结束（收到 [DONE]）
fn handle_sse_line(line: &str, channel: &Channel<StreamEvent>) -> Result<bool> {
    let data = match line.strip_prefix("data:") {
        Some(d) => d.trim(),
        None => return Ok(false),
    };
    if data == "[DONE]" {
        return Ok(true);
    }
    match serde_json::from_str::<ChatChunk>(data) {
        Ok(chunk) => {
            if let Some(text) = chunk.choices.first().and_then(|c| c.delta.content.clone()) {
                if !text.is_empty() {
                    channel
                        .send(StreamEvent::Delta { text })
                        .map_err(|e| anyhow!("推送前端失败: {e}"))?;
                }
            }
        }
        Err(_) => {
            // 心跳/注释行等无法解析的内容，忽略
        }
    }
    Ok(false)
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<RespChoice>,
}

#[derive(Deserialize)]
struct RespChoice {
    message: RespMessage,
}

#[derive(Deserialize)]
struct RespMessage {
    content: String,
}

/// 非流式对话：用于摘要生成等"要一个完整结果"的场景
pub async fn chat_once(cfg: LlmConfig, messages: Vec<(String, String)>) -> Result<String> {
    // 空内容重试一次：思考型模型偶发正文为空，或平台内容过滤抽风
    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 0..2 {
        match chat_once_inner(&cfg, &messages).await {
            Ok(text) => return Ok(text),
            Err(e) => {
                let is_empty = e.to_string().contains("空内容");
                if !is_empty || attempt == 1 {
                    return Err(e);
                }
                last_err = Some(e);
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("LLM 调用失败")))
}

async fn chat_once_inner(cfg: &LlmConfig, messages: &[(String, String)]) -> Result<String> {
    if cfg.api_key.trim().is_empty() {
        return Err(anyhow!("尚未配置 LLM API Key，请先在设置中填写"));
    }
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let body = ChatRequest {
        model: cfg.model.clone(),
        messages: messages
            .iter()
            .map(|(role, content)| ChatMessage {
                role: role.clone(),
                content: content.clone(),
            })
            .collect(),
        stream: false,
        temperature: 0.3,
        // 批量写章等非流式场景要拿完整长文，显式放宽输出上限（DeepSeek 上限 8192）
        max_tokens: Some(8192),
        thinking: THINKING_DISABLED,
    };
    let resp = reqwest::Client::new()
        .post(&url)
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .await
        .context("请求 LLM 接口失败")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("LLM 接口返回 {status}: {}", truncate(&text, 300)));
    }
    let parsed: ChatResponse = resp.json().await.context("解析 LLM 响应失败")?;
    parsed
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("LLM 返回了空内容"))
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>() + "…"
    }
}
