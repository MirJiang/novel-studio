//! 图生视频：火山方舟 Seedance（异步任务：创建 → 轮询 → 下载落盘）
//!
//! 鉴权复用生图的方舟 API Key（settings: img_base_url / img_api_key），
//! 模型在 settings 的 video_model（默认 doubao-seedance-1-0-pro-250528）。
//! 注意：返回的视频 URL 仅约 24 小时有效，拿到必须立即下载。

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use serde_json::json;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct VideoGenConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10);
const POLL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// 首帧图生视频：镜头静图 + 画面提示词 → 5s / 1080p / 9:16 mp4，写入 out_path
pub async fn generate_from_first_frame(
    cfg: &VideoGenConfig,
    prompt: &str,
    image_path: &Path,
    out_path: &Path,
) -> Result<()> {
    if cfg.api_key.trim().is_empty() {
        return Err(anyhow!(
            "尚未配置方舟 API Key（与生图共用，见「设置 → 封面生图」），或账号未开通视频模型"
        ));
    }
    let bytes = std::fs::read(image_path).context("读取镜头图失败")?;
    let mime = if image_path.extension().is_some_and(|e| e == "png") {
        "image/png"
    } else {
        "image/jpeg"
    };
    let data_url = format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    );

    let client = reqwest::Client::new();
    let base = cfg.base_url.trim_end_matches('/');

    // 1. 创建任务（参数走提示词后缀，官方 demo 同款写法）
    let create_resp = client
        .post(format!("{base}/contents/generations/tasks"))
        .bearer_auth(&cfg.api_key)
        .json(&json!({
            "model": cfg.model,
            "content": [
                {
                    "type": "text",
                    "text": format!("{prompt}，镜头缓慢运动 --resolution 1080p --ratio 9:16 --dur 5")
                },
                {
                    "type": "image_url",
                    "image_url": { "url": data_url },
                    "role": "first_frame"
                }
            ]
        }))
        .send()
        .await
        .context("请求视频生成接口失败")?;
    let create_json: serde_json::Value = create_resp.json().await.context("解析创建响应失败")?;
    if let Some(err) = create_json.get("error") {
        let msg = err["message"].as_str().unwrap_or("未知错误");
        return Err(anyhow!("创建视频任务失败: {msg}"));
    }
    let task_id = create_json["id"]
        .as_str()
        .ok_or_else(|| anyhow!("创建响应缺少任务 id: {create_json}"))?
        .to_string();

    // 2. 轮询任务状态（10s 一次，15 分钟超时）
    let deadline = std::time::Instant::now() + POLL_TIMEOUT;
    let video_url = loop {
        if std::time::Instant::now() > deadline {
            return Err(anyhow!("视频生成超时（15 分钟），可到任务面板重试"));
        }
        tokio::time::sleep(POLL_INTERVAL).await;
        let query: serde_json::Value = client
            .get(format!("{base}/contents/generations/tasks/{task_id}"))
            .bearer_auth(&cfg.api_key)
            .send()
            .await
            .context("查询视频任务失败")?
            .json()
            .await
            .context("解析任务状态失败")?;
        match query["status"].as_str() {
            Some("succeeded") => {
                let url = query["result"]["content"]["video_url"]
                    .as_str()
                    .ok_or_else(|| anyhow!("任务成功但缺少 video_url: {query}"))?;
                break url.to_string();
            }
            Some("failed") | Some("cancelled") | Some("expired") => {
                let msg = query["error"]["message"].as_str().unwrap_or("未知原因");
                return Err(anyhow!("视频任务{}: {msg}", query["status"].as_str().unwrap()));
            }
            _ => continue, // queued / running
        }
    };

    // 3. URL 仅约 24h 有效，立即下载落盘
    let bytes = client
        .get(&video_url)
        .send()
        .await
        .context("下载生成视频失败")?
        .bytes()
        .await
        .context("读取视频流失败")?;
    std::fs::write(out_path, &bytes).context("保存镜头视频失败")?;
    Ok(())
}
