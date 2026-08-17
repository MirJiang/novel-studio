//! 番茄小说在线搜书（仅供个人学习与风格分析，UI 已附版权提示）
//!
//! 官方 API 直连，不经第三方中继：fanqie-rs（MIT）实现的 Reading iOS 请求签名 +
//! 正文 AES/gzip 解密；正文走官方 App 的 batch_full 批量接口（≤30 章/请求）。
//! 客户端是 blocking 实现，全部调用包在 spawn_blocking 里。

use crate::commands::ProgressEvent;
use anyhow::{anyhow, Context, Result};
use fanqie_rs::app::crypto::{decrypt_chapter_text, extract_text};
use fanqie_rs::app::download::{register_key, SessionKey};
use fanqie_rs::app::{parse_directory, FanqieClient};
use serde::Serialize;
use tauri::ipc::Channel;

/// 每批章数（官方接口上限 30）
const BATCH_SIZE: usize = 30;
/// 蒸馏样本默认目标字数（蒸馏输入上限 12000，多抓一点留头中尾取样余量）
const SAMPLE_CHARS: usize = 15000;
/// 批次间隔（礼貌限速）
const BATCH_DELAY: std::time::Duration = std::time::Duration::from_millis(400);

#[derive(Debug, Serialize)]
pub struct FqBook {
    pub book_id: String,
    pub name: String,
    pub author: String,
    pub category: String,
    pub word_number: i64,
    #[serde(rename = "abstract")]
    pub abstract_text: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct FqChapter {
    pub title: String,
    pub item_id: String,
}

#[derive(Debug, Serialize)]
pub struct FqCatalog {
    pub name: String,
    pub author: String,
    pub chapters: Vec<FqChapter>,
}

#[derive(Debug, Serialize)]
pub struct FqSample {
    pub name: String,
    pub author: String,
    pub chars: usize,
    pub text: String,
}

fn new_client() -> Result<FanqieClient, String> {
    FanqieClient::create(std::time::Duration::from_secs(30))
        .map_err(|e| format!("初始化番茄客户端失败: {e}"))
}

/// JSON 值宽容取字符串（数字/字符串都行）
fn v_str(v: &serde_json::Value) -> String {
    v.as_str()
        .map(str::to_string)
        .or_else(|| v.as_i64().map(|n| n.to_string()))
        .or_else(|| v.as_u64().map(|n| n.to_string()))
        .unwrap_or_default()
}

/// 递归收集所有 book_data 条目（官方/中继响应层级不同，不赌固定路径）
fn collect_books(v: &serde_json::Value, out: &mut Vec<FqBook>, seen: &mut std::collections::HashSet<String>) {
    match v {
        serde_json::Value::Object(m) => {
            if let Some(arr) = m.get("book_data").and_then(|x| x.as_array()) {
                for b in arr {
                    let id = v_str(&b["book_id"]);
                    let name = v_str(&b["book_name"]);
                    if id.is_empty() || name.is_empty() || !seen.insert(id.clone()) {
                        continue;
                    }
                    out.push(FqBook {
                        book_id: id,
                        name,
                        author: v_str(&b["author"]),
                        category: v_str(&b["category"]),
                        word_number: b["word_number"]
                            .as_i64()
                            .or_else(|| v_str(&b["word_number"]).parse().ok())
                            .unwrap_or(0),
                        abstract_text: v_str(&b["abstract"]),
                    });
                }
            }
            for vv in m.values() {
                collect_books(vv, out, seen);
            }
        }
        serde_json::Value::Array(a) => {
            for vv in a {
                collect_books(vv, out, seen);
            }
        }
        _ => {}
    }
}

fn search_blocking(query: &str) -> Result<Vec<FqBook>, String> {
    let client = new_client()?;
    let resp = client
        .search(query, 0, 20)
        .map_err(|e| format!("搜索请求失败: {e}"))?;
    let mut books = Vec::new();
    let mut seen = std::collections::HashSet::new();
    collect_books(&resp, &mut books, &mut seen);
    books.truncate(20);
    Ok(books)
}

#[tauri::command]
pub async fn fq_search(query: String) -> Result<Vec<FqBook>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Err("请输入书名或作者关键词".to_string());
    }
    tokio::task::spawn_blocking(move || search_blocking(&q))
        .await
        .map_err(|e| e.to_string())?
}

fn catalog_blocking(book_id: &str) -> Result<FqCatalog, String> {
    let client = new_client()?;
    let resp = client
        .directory(book_id)
        .map_err(|e| format!("目录请求失败: {e}"))?;
    let book = parse_directory(&resp, book_id);
    if book.chapters.is_empty() {
        return Err("目录为空（书籍 id 有误或接口变动）".to_string());
    }
    Ok(FqCatalog {
        name: if book.book_name.is_empty() {
            "未命名".to_string()
        } else {
            book.book_name
        },
        author: book.author,
        chapters: book
            .chapters
            .into_iter()
            .map(|c| FqChapter {
                title: c.title,
                item_id: c.item_id,
            })
            .collect(),
    })
}

// ---------- 正文抓取（注册密钥 → batch_full → 解密） ----------

fn looks_like_base64_cipher(content: &str) -> bool {
    content.len() >= 32
        && content
            .bytes()
            .take(80)
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
}

/// 单章正文：明文直接抽文本；密文用会话密钥解密（AES + gzip）
fn chapter_text(v: &serde_json::Value, key: Option<&[u8; 16]>) -> Result<String> {
    let content = v["content"].as_str().unwrap_or_default();
    let crypt = v["crypt_status"].as_i64().unwrap_or(0);
    if content.is_empty() || content == "Invalid" {
        return Err(anyhow!("章节锁定或为空 (crypt_status={crypt})"));
    }
    if crypt == 0 && !looks_like_base64_cipher(content) {
        return Ok(extract_text(content));
    }
    let key = key.context("章节加密但没有会话密钥")?;
    decrypt_chapter_text(content, key)
}

/// 密钥版本漂移检测（服务端轮换 keyver 时需重新注册）
fn needs_new_key(data: &serde_json::Value, ids: &[String], session: &SessionKey) -> bool {
    ids.iter().any(|id| {
        let c = &data[id];
        let kv = c["key_version"].as_i64().unwrap_or(0);
        let cs = c["crypt_status"].as_i64().unwrap_or(0);
        cs != 0 && kv != 0 && kv != session.keyver
    })
}

/// 按批抓取章节正文：on_batch(done, total) 汇报进度，返回 (成功章标题+正文, 失败数)
fn fetch_chapters(
    client: &FanqieClient,
    book_id: &str,
    chapters: &[FqChapter],
    mut on_batch: impl FnMut(usize, usize),
) -> Result<Vec<(String, String)>, String> {
    let mut session = register_key(client).ok(); // 密钥注册失败不致命（明文章节仍可读）
    let total = chapters.len();
    let mut results: Vec<(String, String)> = Vec::new();
    for batch in chapters.chunks(BATCH_SIZE) {
        let ids: Vec<String> = batch.iter().map(|c| c.item_id.clone()).collect();
        let mut data = client
            .batch_full(&ids, session.as_ref().map_or(0, |s| s.key_register_ts), book_id)
            .map_err(|e| format!("正文批量请求失败: {e}"))?["data"]
            .clone();
        // 密钥版本漂移：重注册后重试一次本批
        if let Some(active) = session.as_ref() {
            if needs_new_key(&data, &ids, active) {
                if let Ok(fresh) = register_key(client) {
                    data = client
                        .batch_full(&ids, fresh.key_register_ts, book_id)
                        .map_err(|e| format!("正文批量请求失败（换密钥后重试）: {e}"))?["data"]
                        .clone();
                    session = Some(fresh);
                }
            }
        }
        for ch in batch {
            match chapter_text(&data[&ch.item_id], session.as_ref().map(|s| &s.key)) {
                Ok(t) => results.push((ch.title.clone(), t)),
                Err(_) => {
                    results.push((ch.title.clone(), "[本章抓取失败，可稍后重试]".to_string()));
                }
            }
        }
        on_batch(results.len(), total);
        std::thread::sleep(BATCH_DELAY);
    }
    Ok(results)
}

/// 抓蒸馏样本：从第 1 章顺序抓到目标字数，返回书名+样本全文
#[tauri::command]
pub async fn fq_distill_sample(
    book_id: String,
    max_chars: Option<usize>,
) -> Result<FqSample, String> {
    let id = book_id.trim().to_string();
    let max = max_chars.unwrap_or(SAMPLE_CHARS);
    tokio::task::spawn_blocking(move || {
        let client = new_client()?;
        let cat = catalog_blocking(&id)?;
        // 一章约 2~3 千字，抓一批（30 章）足够样本量
        let take = cat.chapters.len().min(BATCH_SIZE);
        let results = fetch_chapters(&client, &id, &cat.chapters[..take], |_, _| {})?;
        let mut text = String::new();
        for (title, body) in &results {
            if text.chars().count() >= max {
                break;
            }
            text.push_str(&format!("\n\n{}\n{}", title, body));
        }
        let chars = text.chars().count();
        if chars < 500 {
            return Err("抓到的正文太少（接口可能有变），换一本或稍后再试".to_string());
        }
        Ok(FqSample {
            name: cat.name,
            author: cat.author,
            chars,
            text,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 下载全本为 txt（进度事件；失败章节留占位行不中断），返回结果说明
#[tauri::command]
pub async fn fq_download(
    book_id: String,
    path: String,
    channel: Channel<ProgressEvent>,
) -> Result<String, String> {
    let id = book_id.trim().to_string();
    tokio::task::spawn_blocking(move || {
        let client = new_client()?;
        let cat = match catalog_blocking(&id) {
            Ok(c) => c,
            Err(e) => {
                let _ = channel.send(ProgressEvent::Error { message: e.clone() });
                return Err(e);
            }
        };
        let total = cat.chapters.len() as i64;
        let results = fetch_chapters(&client, &id, &cat.chapters, |done, tot| {
            let _ = channel.send(ProgressEvent::Progress {
                current: done as i64,
                total: tot as i64,
                label: format!("已抓取 {done}/{tot} 章"),
            });
        })?;
        let mut out = format!(
            "《{}》{}\n\n（番茄小说在线下载，仅供个人学习与风格分析，请勿传播）\n",
            cat.name, cat.author
        );
        let mut failed = 0i64;
        for (title, body) in &results {
            if body.starts_with("[本章抓取失败") {
                failed += 1;
            }
            out.push_str(&format!("\n\n{}\n\n{}", title, body));
        }
        if let Err(e) = std::fs::write(&path, &out) {
            let msg = format!("写入文件失败: {e}");
            let _ = channel.send(ProgressEvent::Error { message: msg.clone() });
            return Err(msg);
        }
        let _ = channel.send(ProgressEvent::Progress {
            current: total,
            total,
            label: "完成".to_string(),
        });
        let _ = channel.send(ProgressEvent::Done);
        Ok(format!(
            "已保存：{} 章{}",
            total,
            if failed > 0 {
                format!("（{failed} 章抓取失败留了占位）")
            } else {
                String::new()
            }
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

