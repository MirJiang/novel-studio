//! 图生视频：火山方舟 Seedance（异步任务：创建 → 轮询 → 下载落盘）
//!
//! 鉴权复用生图的方舟 API Key（settings: img_base_url / img_api_key），
//! 模型在 settings 的 video_model（建议 Seedance 2.x，支持 reference_image 多图参考锁角色）。
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
    /// 单镜时长（秒）：调研结论是 3~5s 短镜拼接最稳，长尾段风格会衰减
    pub duration_secs: u32,
}

const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10);
const POLL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

fn file_to_data_url(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).context("读取图片失败")?;
    let mime = if path.extension().is_some_and(|e| e == "png") {
        "image/png"
    } else {
        "image/jpeg"
    };
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// 首帧图生视频：镜头静图（首帧）+ 角色参考图 + 画面提示词 → 9:16 mp4，写入 out_path。
/// refs 为角色参考图路径（≤3 张，调研结论：参考图过多反而漂移）；
/// 老模型（Seedance 1.0）不认 reference_image 角色，创建失败时自动降级为无参考重试一次。
pub async fn generate_from_first_frame(
    cfg: &VideoGenConfig,
    prompt: &str,
    image_path: &Path,
    refs: &[String],
    out_path: &Path,
) -> Result<()> {
    if cfg.api_key.trim().is_empty() {
        return Err(anyhow!(
            "尚未配置方舟 API Key（与生图共用，见「设置 → 封面生图」），或账号未开通视频模型"
        ));
    }
    let client = reqwest::Client::new();
    let base = cfg.base_url.trim_end_matches('/').to_string();

    let content = vec![
        json!({
            "type": "text",
            // 参数走提示词后缀，官方 demo 同款写法；时长收敛防漂移（见 docs/research-video-2026-08.md）
            "text": format!("{prompt} --resolution 1080p --ratio 9:16 --dur {}", cfg.duration_secs)
        }),
        json!({
            "type": "image_url",
            "image_url": { "url": file_to_data_url(image_path)? },
            "role": "first_frame"
        }),
    ];
    let mut ref_urls: Vec<String> = Vec::new();
    for r in refs {
        ref_urls.push(file_to_data_url(Path::new(r))?);
    }

    // 创建任务；带参考图失败（老模型不支持 reference_image）时降级重试一次
    let task_id = match create_task(&client, &base, cfg, &content, &ref_urls).await {
        Ok(id) => id,
        Err(e) if !ref_urls.is_empty() => create_task(&client, &base, cfg, &content, &[])
            .await
            .map_err(|e2| {
                anyhow!("创建视频任务失败（已降级为无参考图重试）: {e2}；首次报错: {e}")
            })?,
        Err(e) => return Err(e),
    };

    // 轮询任务状态（10s 一次，15 分钟超时）
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
                return Err(anyhow!(
                    "视频任务{}: {msg}",
                    query["status"].as_str().unwrap()
                ));
            }
            _ => continue, // queued / running
        }
    };

    // URL 仅约 24h 有效，立即下载落盘
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

async fn create_task(
    client: &reqwest::Client,
    base: &str,
    cfg: &VideoGenConfig,
    content: &[serde_json::Value],
    ref_urls: &[String],
) -> Result<String> {
    let mut content = content.to_vec();
    for url in ref_urls {
        content.push(json!({
            "type": "image_url",
            "image_url": { "url": url },
            "role": "reference_image"
        }));
    }
    let resp = client
        .post(format!("{base}/contents/generations/tasks"))
        .bearer_auth(&cfg.api_key)
        .json(&json!({ "model": cfg.model, "content": content }))
        .send()
        .await
        .context("请求视频生成接口失败")?;
    let create_json: serde_json::Value = resp.json().await.context("解析创建响应失败")?;
    if let Some(err) = create_json.get("error") {
        let msg = err["message"].as_str().unwrap_or("未知错误");
        return Err(anyhow!("创建视频任务失败: {msg}"));
    }
    create_json["id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| anyhow!("创建响应缺少任务 id: {create_json}"))
}
