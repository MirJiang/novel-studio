//! LLM 接入层：两套标准协议——OpenAI 兼容（chat/completions）与 Anthropic（messages）
//!
//! 协议只有这两套（见 docs/decisions.md D27）：国内外主流模型与自定义网关
//! 都通过这两套协议接入，不为单个厂商写私有协议。
//! OpenAI 协议覆盖 DeepSeek / 通义 / Kimi / 智谱 / OpenAI / OpenRouter / one-api 等；
//! Anthropic 协议覆盖 Claude 官方及其中转。

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

/// 推送给前端的流式事件（serde tag 序列化为 { type: "delta" | "done" | "error" | "meta", ... }）
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    /// 本次生成的元信息（如注入了哪些设定），在 delta 之前发送
    Meta {
        note: String,
    },
    Delta {
        text: String,
    },
    Done,
    Error {
        message: String,
    },
}

/// 接入协议：openai = chat/completions；anthropic = messages
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LlmProtocol {
    OpenAI,
    Anthropic,
}

#[derive(Debug, Clone)]
pub struct LlmConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub protocol: LlmProtocol,
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
    match cfg.protocol {
        LlmProtocol::OpenAI => stream_openai(&cfg, messages, &channel).await,
        LlmProtocol::Anthropic => stream_anthropic(&cfg, messages, &channel).await,
    }
}

/// 通用 SSE 泵：按行读取 "data: ..." 负载交给 on_data，返回 true 表示流结束
async fn pump_sse<F>(
    resp: reqwest::Response,
    channel: &Channel<StreamEvent>,
    on_data: &mut F,
) -> Result<()>
where
    F: FnMut(&str) -> Result<bool> + Send,
{
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
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            if on_data(data.trim())? {
                let _ = channel.send(StreamEvent::Done);
                return Ok(());
            }
        }
    }

    let _ = channel.send(StreamEvent::Done);
    Ok(())
}

/// 非 2xx 响应统一转成 Error 事件，返回 true 表示已处理（调用方直接 return）
fn emit_http_error(status: reqwest::StatusCode, text: &str, channel: &Channel<StreamEvent>) {
    let _ = channel.send(StreamEvent::Error {
        message: format!("LLM 接口返回 {status}: {}", truncate(text, 300)),
    });
}

// ---------- OpenAI 协议 ----------

async fn stream_openai(
    cfg: &LlmConfig,
    messages: Vec<(String, String)>,
    channel: &Channel<StreamEvent>,
) -> Result<()> {
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
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
        emit_http_error(status, &text, channel);
        return Ok(());
    }

    pump_sse(resp, channel, &mut |data| {
        if data == "[DONE]" {
            return Ok(true);
        }
        // 心跳/注释行等无法解析的内容，忽略
        if let Ok(chunk) = serde_json::from_str::<ChatChunk>(data) {
            if let Some(text) = chunk.choices.first().and_then(|c| c.delta.content.clone()) {
                if !text.is_empty() {
                    channel
                        .send(StreamEvent::Delta { text })
                        .map_err(|e| anyhow!("推送前端失败: {e}"))?;
                }
            }
        }
        Ok(false)
    })
    .await
}

// ---------- Anthropic 协议 ----------

#[derive(Serialize)]
struct AnthropicRequest {
    model: String,
    /// Anthropic 必填；Claude 各代输出上限 ≥8192，写章场景取安全值
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    messages: Vec<AnthropicMessage>,
    stream: bool,
    temperature: f32,
}

#[derive(Serialize)]
struct AnthropicMessage {
    role: String,
    content: String,
}

/// 消息转换：system 抽成独立字段；user/assistant 交替（连续同角色合并，Anthropic 硬性要求）
fn to_anthropic_messages(messages: &[(String, String)]) -> (Option<String>, Vec<AnthropicMessage>) {
    let mut system_parts: Vec<&str> = Vec::new();
    let mut out: Vec<AnthropicMessage> = Vec::new();
    for (role, content) in messages {
        if role == "system" {
            system_parts.push(content);
            continue;
        }
        let role = if role == "assistant" {
            "assistant"
        } else {
            "user"
        };
        match out.last_mut() {
            Some(last) if last.role == role => {
                last.content.push_str("\n\n");
                last.content.push_str(content);
            }
            _ => out.push(AnthropicMessage {
                role: role.to_string(),
                content: content.clone(),
            }),
        }
    }
    let system = if system_parts.is_empty() {
        None
    } else {
        Some(system_parts.join("\n\n"))
    };
    (system, out)
}

fn anthropic_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    // 官方 base 是 https://api.anthropic.com（不含 /v1），中转站常带 /v1
    if base.ends_with("/v1") {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
    }
}

#[derive(Deserialize)]
struct AnthropicStreamEvent {
    #[serde(rename = "type")]
    kind: String,
    delta: Option<AnthropicStreamDelta>,
    error: Option<AnthropicStreamError>,
}

#[derive(Deserialize)]
struct AnthropicStreamDelta {
    text: Option<String>,
}

#[derive(Deserialize)]
struct AnthropicStreamError {
    message: String,
}

async fn stream_anthropic(
    cfg: &LlmConfig,
    messages: Vec<(String, String)>,
    channel: &Channel<StreamEvent>,
) -> Result<()> {
    let (system, msgs) = to_anthropic_messages(&messages);
    let body = AnthropicRequest {
        model: cfg.model.clone(),
        max_tokens: 8192,
        system,
        messages: msgs,
        stream: true,
        temperature: 0.8,
    };
    let resp = reqwest::Client::new()
        .post(anthropic_url(&cfg.base_url))
        .header("x-api-key", &cfg.api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .context("请求 LLM 接口失败")?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        emit_http_error(status, &text, channel);
        return Ok(());
    }

    pump_sse(resp, channel, &mut |data| {
        let Ok(ev) = serde_json::from_str::<AnthropicStreamEvent>(data) else {
            return Ok(false); // ping 等无 type 的行忽略
        };
        match ev.kind.as_str() {
            "content_block_delta" => {
                if let Some(text) = ev.delta.and_then(|d| d.text) {
                    if !text.is_empty() {
                        channel
                            .send(StreamEvent::Delta { text })
                            .map_err(|e| anyhow!("推送前端失败: {e}"))?;
                    }
                }
            }
            "message_stop" => return Ok(true),
            "error" => {
                let msg = ev
                    .error
                    .map(|e| e.message)
                    .unwrap_or_else(|| "未知错误".into());
                let _ = channel.send(StreamEvent::Error {
                    message: format!("LLM 流式错误: {msg}"),
                });
                return Ok(true);
            }
            _ => {}
        }
        Ok(false)
    })
    .await
}

#[derive(Deserialize)]
struct AnthropicResponse {
    content: Vec<AnthropicContent>,
}

#[derive(Deserialize)]
struct AnthropicContent {
    text: Option<String>,
}

async fn chat_once_anthropic(cfg: &LlmConfig, messages: &[(String, String)]) -> Result<String> {
    let (system, msgs) = to_anthropic_messages(messages);
    let body = AnthropicRequest {
        model: cfg.model.clone(),
        max_tokens: 8192,
        system,
        messages: msgs,
        stream: false,
        temperature: 0.3,
    };
    let resp = reqwest::Client::new()
        .post(anthropic_url(&cfg.base_url))
        .header("x-api-key", &cfg.api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .context("请求 LLM 接口失败")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("LLM 接口返回 {status}: {}", truncate(&text, 300)));
    }
    let parsed: AnthropicResponse = resp.json().await.context("解析 LLM 响应失败")?;
    let text: String = parsed
        .content
        .into_iter()
        .filter_map(|c| c.text)
        .collect::<Vec<_>>()
        .join("");
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(anyhow!("LLM 返回了空内容"));
    }
    Ok(text)
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
    if cfg.protocol == LlmProtocol::Anthropic {
        return chat_once_anthropic(cfg, messages).await;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn msgs(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(r, c)| (r.to_string(), c.to_string()))
            .collect()
    }

    #[test]
    fn anthropic_messages_extract_system_and_keep_order() {
        let (system, out) = to_anthropic_messages(&msgs(&[
            ("system", "设定A"),
            ("system", "设定B"),
            ("user", "你好"),
            ("assistant", "在"),
            ("user", "续写"),
        ]));
        assert_eq!(system.as_deref(), Some("设定A\n\n设定B"));
        let roles: Vec<&str> = out.iter().map(|m| m.role.as_str()).collect();
        assert_eq!(roles, ["user", "assistant", "user"]);
    }

    #[test]
    fn anthropic_messages_merge_consecutive_same_role() {
        let (_s, out) = to_anthropic_messages(&msgs(&[("user", "第一段"), ("user", "第二段")]));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].content, "第一段\n\n第二段");
    }

    #[test]
    fn anthropic_url_handles_base_with_or_without_v1() {
        assert_eq!(
            anthropic_url("https://api.anthropic.com"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            anthropic_url("https://relay.example.com/v1/"),
            "https://relay.example.com/v1/messages"
        );
    }
}
