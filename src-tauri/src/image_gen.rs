//! 封面生成：AI 生图（OpenAI Images 兼容协议）+ 程序化文字排版
//!
//! 设计依据（docs/decisions.md D11）：
//! - 扩散模型渲染中文标题不可靠，所以模型只画背景，书名/作者由程序排版
//! - 字体用 Windows 系统自带中文字体（微软雅黑等），不打包子集字体
//! - 白字 + 深色描边，保证在任何底图上可读

use ab_glyph::{Font, FontVec, PxScale, ScaleFont};
use anyhow::{anyhow, Context, Result};
use base64::Engine;
use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use imageproc::drawing::draw_text_mut;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct ImageConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

/// 封面尺寸：3:4 竖版（番茄 600x800、起点 600x800 同比例，高清出图后平台自行压缩）
pub const COVER_SIZE: &str = "1536x2048";

#[derive(Serialize)]
struct ImagesRequest<'a> {
    model: &'a str,
    prompt: &'a str,
    size: &'a str,
    response_format: &'a str,
    /// 参考图（data URL），火山 Seedream 4.0 的 image 字段；空则纯文生图
    #[serde(skip_serializing_if = "Vec::is_empty")]
    image: Vec<String>,
}

#[derive(Deserialize)]
struct ImagesResponse {
    data: Vec<ImageData>,
}

#[derive(Deserialize)]
struct ImageData {
    url: Option<String>,
    b64_json: Option<String>,
}

/// 调生图接口，返回图片字节。refs 为可选参考图（data URL），用于角色一致性
pub async fn generate_image(
    cfg: &ImageConfig,
    prompt: &str,
    size: &str,
    refs: &[String],
) -> Result<Vec<u8>> {
    if cfg.api_key.trim().is_empty() {
        return Err(anyhow!("尚未配置生图 API Key，请先在设置中填写"));
    }
    let url = format!("{}/images/generations", cfg.base_url.trim_end_matches('/'));
    let body = ImagesRequest {
        model: &cfg.model,
        prompt,
        size,
        response_format: "url",
        image: refs.to_vec(),
    };
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .await
        .context("请求生图接口失败")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let short: String = text.chars().take(300).collect();
        return Err(anyhow!("生图接口返回 {status}: {short}"));
    }
    let parsed: ImagesResponse = resp.json().await.context("解析生图响应失败")?;
    let first = parsed
        .data
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("生图接口没有返回图片"))?;

    if let Some(u) = first.url {
        let bytes = client
            .get(&u)
            .send()
            .await
            .context("下载生成图失败")?
            .bytes()
            .await
            .context("读取生成图失败")?;
        return Ok(bytes.to_vec());
    }
    if let Some(b64) = first.b64_json {
        return base64::engine::general_purpose::STANDARD
            .decode(b64)
            .context("解码 base64 图片失败");
    }
    Err(anyhow!("生图接口返回格式不支持"))
}

/// 在底图上排版书名与作者，输出 PNG 字节
pub fn compose_cover(bg: &[u8], title: &str, author: &str) -> Result<Vec<u8>> {
    let mut img = image::load_from_memory(bg)
        .context("解码封面底图失败")?
        .to_rgba8();
    let (w, h) = (img.width() as f32, img.height() as f32);
    let font = load_cjk_font()?;

    // 书名：顶部居中，超宽自动缩小
    let title = title.trim();
    if !title.is_empty() {
        let mut scale = w / 5.5;
        let mut tw = text_width(&font, scale, title);
        if tw > w * 0.86 {
            scale *= w * 0.86 / tw;
            tw = text_width(&font, scale, title);
        }
        let x = ((w - tw) / 2.0).max(0.0) as i32;
        let y = (h * 0.10) as i32;
        draw_stroked(&mut img, &font, scale, x, y, title);
    }

    // 作者：底部居中，「xxx 著」
    let author = author.trim();
    if !author.is_empty() {
        let text = format!("{author} 著");
        let scale = w / 16.0;
        let tw = text_width(&font, scale, &text);
        let x = ((w - tw) / 2.0).max(0.0) as i32;
        let y = (h * 0.90) as i32;
        draw_stroked(&mut img, &font, scale, x, y, &text);
    }

    let mut out = std::io::Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(img)
        .write_to(&mut out, ImageFormat::Png)
        .context("编码封面失败")?;
    Ok(out.into_inner())
}

/// 从 Windows 系统字体目录找可用的中文字体（雅黑 Bold → 雅黑 → 黑体 → 宋体）
fn load_cjk_font() -> Result<FontVec> {
    let windir = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".to_string());
    for name in ["msyhbd.ttc", "msyh.ttc", "simhei.ttf", "simsun.ttc"] {
        let path = format!(r"{windir}\Fonts\{name}");
        if let Ok(data) = std::fs::read(&path) {
            // ttc/ttf 都先试 index 0
            if let Ok(font) = FontVec::try_from_vec_and_index(data, 0) {
                return Ok(font);
            }
        }
    }
    Err(anyhow!(
        "未找到可用中文字体（尝试过 微软雅黑/黑体/宋体）"
    ))
}

fn text_width(font: &FontVec, scale: f32, text: &str) -> f32 {
    let scaled = font.as_scaled(PxScale::from(scale));
    text.chars()
        .map(|c| scaled.h_advance(scaled.glyph_id(c)))
        .sum()
}

/// 深色描边 + 白色填充，任何底图上都可读
fn draw_stroked(img: &mut RgbaImage, font: &FontVec, scale: f32, x: i32, y: i32, text: &str) {
    let stroke = ((scale / 22.0).round() as i32).clamp(2, 8);
    let dark = Rgba([10u8, 10, 10, 230]);
    for dy in -stroke..=stroke {
        for dx in -stroke..=stroke {
            if dx * dx + dy * dy <= stroke * stroke {
                draw_text_mut(img, dark, x + dx, y + dy, PxScale::from(scale), font, text);
            }
        }
    }
    draw_text_mut(
        img,
        Rgba([255u8, 255, 255, 255]),
        x,
        y,
        PxScale::from(scale),
        font,
        text,
    );
}
