//! 推文视频基础设施：火山引擎 TTS + ffmpeg/ffprobe 探测与合成
//!
//! 设计依据（docs/prd.md v0.4）：
//! - TTS 走火山引擎官方 openspeech API（不用 edge-tts 等非官方端点）
//! - 视频合成调本机 ffmpeg CLI；二进制随应用分发（binaries/ 目录）
//! - 第一刀为"静图 + zoompan 运镜"模式，图生视频 API 后续切片接入

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

// ---------- 火山引擎 TTS ----------

#[derive(Debug, Clone)]
pub struct TtsConfig {
    pub app_id: String,
    pub access_token: String,
    pub cluster: String,
    pub voice: String,
}

#[derive(Serialize)]
struct TtsBody<'a> {
    app: TtsApp<'a>,
    user: TtsUser<'a>,
    audio: TtsAudio<'a>,
    request: TtsRequest<'a>,
}
#[derive(Serialize)]
struct TtsApp<'a> {
    appid: &'a str,
    token: &'a str,
    cluster: &'a str,
}
#[derive(Serialize)]
struct TtsUser<'a> {
    uid: &'a str,
}
#[derive(Serialize)]
struct TtsAudio<'a> {
    voice_type: &'a str,
    encoding: &'a str,
    rate: u32,
}
#[derive(Serialize)]
struct TtsRequest<'a> {
    reqid: String,
    text: &'a str,
    operation: &'a str,
}

#[derive(Deserialize)]
struct TtsResp {
    code: i64,
    message: String,
    data: Option<String>,
}

/// 调火山语音合成，返回 mp3 字节
pub async fn tts_synthesize(cfg: &TtsConfig, text: &str) -> Result<Vec<u8>> {
    if cfg.app_id.trim().is_empty() || cfg.access_token.trim().is_empty() {
        return Err(anyhow!(
            "尚未配置配音凭证，请到「设置 → 配音 TTS」填写 App ID 和 Access Token"
        ));
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let body = TtsBody {
        app: TtsApp {
            appid: &cfg.app_id,
            token: &cfg.access_token,
            cluster: &cfg.cluster,
        },
        user: TtsUser { uid: "novel-studio" },
        audio: TtsAudio {
            voice_type: &cfg.voice,
            encoding: "mp3",
            rate: 16000,
        },
        request: TtsRequest {
            reqid: format!("{nanos:x}{}", std::process::id()),
            text,
            operation: "query",
        },
    };
    let resp = reqwest::Client::new()
        .post("https://openspeech.bytedance.com/api/v1/tts")
        // 火山鉴权格式特殊：Bearer;{token}（分号）
        .header("Authorization", format!("Bearer;{}", cfg.access_token))
        .json(&body)
        .send()
        .await
        .context("请求 TTS 接口失败")?;
    let parsed: TtsResp = resp.json().await.context("解析 TTS 响应失败")?;
    if parsed.code != 3000 {
        return Err(anyhow!(
            "TTS 接口返回 {}: {}",
            parsed.code,
            parsed.message
        ));
    }
    let b64 = parsed.data.ok_or_else(|| anyhow!("TTS 没有返回音频"))?;
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .context("解码 TTS 音频失败")
}

// ---------- ffmpeg / ffprobe 探测 ----------

/// 查找顺序：PATH → 应用 exe 旁 binaries/ → exe 旁
fn find_tool(name: &str) -> Result<PathBuf> {
    if let Ok(out) = Command::new(name).arg("-version").output() {
        if out.status.success() {
            return Ok(PathBuf::from(name));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for cand in [
                dir.join("binaries").join(format!("{name}.exe")),
                dir.join(format!("{name}.exe")),
            ] {
                if cand.exists() {
                    return Ok(cand);
                }
            }
        }
    }
    Err(anyhow!(
        "未找到 {name}。请安装 ffmpeg（加入 PATH），或把 {name}.exe 放到应用目录的 binaries/ 下"
    ))
}

fn run_tool(bin: &Path, args: &[String], cwd: &Path) -> Result<()> {
    let out = Command::new(bin)
        .args(args)
        .current_dir(cwd)
        .output()
        .with_context(|| format!("执行 {} 失败", bin.display()))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: String = stderr.chars().rev().take(400).collect::<String>().chars().rev().collect();
        return Err(anyhow!("{} 执行失败: {tail}", bin.display()));
    }
    Ok(())
}

/// 用 ffprobe 读音频时长（毫秒）
pub fn probe_duration_ms(path: &Path) -> Result<i64> {
    let ffprobe = find_tool("ffprobe")?;
    let out = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .context("执行 ffprobe 失败")?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let secs: f64 = text
        .parse()
        .with_context(|| format!("解析音频时长失败: {text}"))?;
    Ok((secs * 1000.0).round() as i64)
}

// ---------- 合成 ----------

pub struct ComposeShot {
    pub image: PathBuf,
    pub audio: PathBuf,
    /// 图生视频产物（有则用真视频，无则静图 zoompan 运镜）
    pub video: Option<PathBuf>,
    pub duration_ms: i64,
    pub text: String,
}

/// 合成竖屏短片：逐镜视频段（真视频或静图推近）→ 拼接 → 配音轨 → 烧录字幕
pub fn compose(video_dir: &Path, shots: &[ComposeShot], out_path: &Path) -> Result<()> {
    let ffmpeg = find_tool("ffmpeg")?;

    // 1. 逐镜生成视频段（1080x1920 30fps）：有镜头视频就循环对齐时长，没有就静图缓慢推近
    let mut seg_names = Vec::new();
    for (i, s) in shots.iter().enumerate() {
        let seg = format!("seg-{i:02}.mp4");
        let secs = (s.duration_ms.max(800) as f64) / 1000.0;
        match &s.video {
            Some(clip) => {
                // 镜头视频（5s）：配音比它长就循环补齐，统一缩放到 1080x1920
                run_tool(
                    &ffmpeg,
                    &[
                        "-stream_loop".into(),
                        "-1".into(),
                        "-i".into(),
                        clip.to_string_lossy().to_string(),
                        "-vf".into(),
                        "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p".into(),
                        "-an".into(),
                        "-c:v".into(),
                        "libx264".into(),
                        "-preset".into(),
                        "veryfast".into(),
                        "-crf".into(),
                        "20".into(),
                        "-t".into(),
                        format!("{secs:.3}"),
                        "-y".into(),
                        seg.clone(),
                    ],
                    video_dir,
                )?;
            }
            None => {
                let frames = (secs * 30.0).ceil() as i64;
                let vf = format!(
                    "zoompan=z='min(1+0.0009*on,1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:fps=30:s=1080x1920,format=yuv420p"
                );
                run_tool(
                    &ffmpeg,
                    &[
                        "-loop".into(),
                        "1".into(),
                        "-i".into(),
                        s.image.to_string_lossy().to_string(),
                        "-vf".into(),
                        vf,
                        "-c:v".into(),
                        "libx264".into(),
                        "-preset".into(),
                        "veryfast".into(),
                        "-crf".into(),
                        "20".into(),
                        "-t".into(),
                        format!("{secs:.3}"),
                        "-y".into(),
                        seg.clone(),
                    ],
                    video_dir,
                )?;
            }
        }
        seg_names.push(seg);
    }

    // 2. 拼接视频段
    let vlist = seg_names
        .iter()
        .map(|s| format!("file '{s}'"))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(video_dir.join("vlist.txt"), vlist)?;
    run_tool(
        &ffmpeg,
        &[
            "-f".into(), "concat".into(), "-safe".into(), "0".into(),
            "-i".into(), "vlist.txt".into(),
            "-c".into(), "copy".into(), "-y".into(), "video-only.mp4".into(),
        ],
        video_dir,
    )?;

    // 3. 拼接音轨（重编码 mp3，避免裸流拼接的时长误差）
    let alist = shots
        .iter()
        .map(|s| format!("file '{}'", s.audio.to_string_lossy()))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(video_dir.join("alist.txt"), alist)?;
    run_tool(
        &ffmpeg,
        &[
            "-f".into(), "concat".into(), "-safe".into(), "0".into(),
            "-i".into(), "alist.txt".into(),
            "-c:a".into(), "libmp3lame".into(), "-q:a".into(), "4".into(),
            "-y".into(), "full-audio.mp3".into(),
        ],
        video_dir,
    )?;

    // 4. 字幕（按各镜音频实际时长排时间轴）
    let mut ass = String::from(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n\
         [V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, \
         Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, \
         Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n\
         Style: Default,Microsoft YaHei,58,&H00FFFFFF,&H00141414,&H64000000,1,0,0,0,100,100,0,0,1,4,2,2,60,60,120,1\n\n\
         [Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
    );
    let mut cursor = 0i64;
    for s in shots {
        let dur = s.duration_ms.max(800);
        ass.push_str(&format!(
            "Dialogue: 0,{},{},Default,,0,0,0,,{}\n",
            fmt_ass_time(cursor),
            fmt_ass_time(cursor + dur),
            ass_escape(&s.text)
        ));
        cursor += dur;
    }
    std::fs::write(video_dir.join("subtitles.ass"), ass)?;

    // 5. 合成终片（烧字幕，-shortest 对齐音画）
    run_tool(
        &ffmpeg,
        &[
            "-i".into(), "video-only.mp4".into(),
            "-i".into(), "full-audio.mp3".into(),
            "-vf".into(), "ass=subtitles.ass".into(),
            "-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(), "-crf".into(), "20".into(),
            "-c:a".into(), "aac".into(), "-b:a".into(), "128k".into(),
            "-shortest".into(), "-y".into(),
            out_path.to_string_lossy().to_string(),
        ],
        video_dir,
    )?;
    Ok(())
}

/// ASS 时间格式 h:mm:ss.cc（厘秒）
fn fmt_ass_time(ms: i64) -> String {
    let cs = ms / 10;
    let (h, rem) = (cs / 360000, cs % 360000);
    let (m, rem) = (rem / 6000, rem % 6000);
    let (s, c) = (rem / 100, rem % 100);
    format!("{h}:{m:02}:{s:02}.{c:02}")
}

fn ass_escape(t: &str) -> String {
    t.replace('\\', "\\\\")
        .replace('{', "\\{")
        .replace('}', "\\}")
        .replace('\n', "\\N")
        .trim()
        .to_string()
}
