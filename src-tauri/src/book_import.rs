//! 本地书籍导入：txt / md / epub / docx 解析 → 作品 + 章节
//!
//! - txt/md：编码自适应（严格 UTF-8，失败回退 GB18030——老书站 txt 多为 GBK）；
//!   按行首标题切章（第N章/卷/回、Chapter N、序章楔子番外尾声等）；
//!   识别不到标题时按约 2 万字在空行边界切块；目录页/卷名行产生的空壳章节过滤掉
//! - epub：解 zip → container.xml 找 OPF → 按书脊顺序逐篇剥标签取纯文本，
//!   章节标题取 h1~h3/title，书名取 dc:title（回退文件名）
//! - docx：解 zip → word/document.xml 剥标签取纯文本，再走 txt 切章逻辑

use crate::db::{count_words, Db, Project};
use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct ImportBookResult {
    pub project: Project,
    pub chapters: i64,
    pub words: i64,
    pub format: String,
}

struct RawChapter {
    title: String,
    text: String,
}

#[tauri::command]
pub fn import_local_book(db: State<'_, Db>, path: String) -> Result<ImportBookResult, String> {
    import(&db, Path::new(&path)).map_err(|e| e.to_string())
}

fn import(db: &Db, path: &Path) -> Result<ImportBookResult> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "未命名书籍".to_string());

    let (name, chapters, format) = match ext.as_str() {
        "txt" | "md" | "markdown" => {
            let bytes = std::fs::read(path).context("读取文件失败")?;
            (stem, split_text_chapters(&decode_text(&bytes)), ext)
        }
        "epub" => parse_epub(path, &stem)?,
        "docx" => {
            let text = read_docx_text(path)?;
            (stem, split_text_chapters(&text), ext)
        }
        other => return Err(anyhow!("不支持的格式 .{other}，目前支持 txt / md / epub / docx")),
    };

    let mut total_words = 0i64;
    let mut items: Vec<(String, String)> = Vec::with_capacity(chapters.len());
    for ch in chapters {
        let text = ch.text.trim();
        if text.is_empty() {
            continue;
        }
        total_words += count_words(text);
        items.push((ch.title, text_to_html(text)));
    }
    if items.is_empty() {
        return Err(anyhow!("没有解析出正文内容"));
    }
    let count = items.len() as i64;
    let project = db.create_project(&name, "本地导入", 0, 0, 0)?;
    if let Err(e) = db.create_chapters_bulk(project.id, &items) {
        let _ = db.delete_project(project.id); // 失败不留半截作品
        return Err(e.context("章节入库失败"));
    }
    Ok(ImportBookResult {
        project,
        chapters: count,
        words: total_words,
        format,
    })
}

// ---------- txt / md ----------

/// 字节 → 文本：优先严格 UTF-8，失败回退 GB18030（GBK 超集，兼容老书站 txt）
fn decode_text(bytes: &[u8]) -> String {
    match String::from_utf8(bytes.to_vec()) {
        Ok(s) => s,
        Err(_) => encoding_rs::GB18030.decode(bytes).0.into_owned(),
    }
}

fn split_text_chapters(text: &str) -> Vec<RawChapter> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = normalized.trim_start_matches('\u{feff}');
    let mut chapters: Vec<RawChapter> = Vec::new();
    let mut title = String::new();
    let mut body = String::new();
    let mut seen_heading = false;

    for line in normalized.lines() {
        if let Some(h) = detect_heading(line) {
            if seen_heading {
                chapters.push(RawChapter {
                    title: std::mem::take(&mut title),
                    text: std::mem::take(&mut body),
                });
            } else {
                // 首个标题前的内容：够长单列「作品相关」，太短则并进第一章
                if body.trim().chars().count() >= 100 {
                    chapters.push(RawChapter {
                        title: "作品相关".to_string(),
                        text: std::mem::take(&mut body),
                    });
                }
                seen_heading = true;
            }
            title = h;
        } else {
            body.push_str(line);
            body.push('\n');
        }
    }

    if seen_heading {
        chapters.push(RawChapter { title, text: body });
        // 目录页、卷名行会产生空壳章节，过滤掉（正文章节不会这么短）
        let chapters: Vec<RawChapter> = chapters
            .into_iter()
            .filter(|c| c.text.trim().chars().count() >= 30)
            .collect();
        if !chapters.is_empty() {
            return chapters;
        }
        // 全是空壳（标题误判）→ 走整本切块兜底
    }
    chunk_whole_text(normalized)
}

/// 兜底：识别不到章节标题，按约 2 万字在空行边界切块（硬顶 4 万字强制切）
fn chunk_whole_text(text: &str) -> Vec<RawChapter> {
    const CHUNK: usize = 20_000;
    let mut chunks: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut cur_chars = 0usize;
    for line in text.lines() {
        cur.push_str(line);
        cur.push('\n');
        cur_chars += line.chars().count();
        if (cur_chars >= CHUNK && line.trim().is_empty()) || cur_chars >= CHUNK * 2 {
            chunks.push(std::mem::take(&mut cur));
            cur_chars = 0;
        }
    }
    if !cur.trim().is_empty() {
        chunks.push(cur);
    }
    match chunks.len() {
        0 => Vec::new(),
        1 => vec![RawChapter {
            title: "全文".to_string(),
            text: chunks.pop().unwrap(),
        }],
        n => chunks
            .into_iter()
            .enumerate()
            .map(|(i, text)| RawChapter {
                title: format!("未分章（{}/{n}）", i + 1),
                text,
            })
            .collect(),
    }
}

/// 行首章节标题识别，命中返回标题文本（整行）
fn detect_heading(line: &str) -> Option<String> {
    let t = line.trim();
    if t.is_empty() || t.chars().count() > 45 {
        return None;
    }
    // markdown 标题（1~3 级）
    if t.starts_with('#') {
        let level = t.chars().take_while(|&c| c == '#').count();
        let rest = t[level..].trim();
        if level <= 3 && !rest.is_empty() {
            return Some(rest.to_string());
        }
        return None;
    }
    let compact: String = t.chars().filter(|c| !c.is_whitespace()).collect();
    // 整行就是标题词（或「正文」这类分卷标记行）
    if matches!(
        compact.as_str(),
        "序" | "序章" | "楔子" | "序言" | "引子" | "前言" | "尾声" | "后记" | "终章" | "正文"
    ) {
        return Some(compact);
    }
    // 番外/序章/终章 可带短后缀（番外篇、序章·起点…）
    for w in ["番外", "序章", "终章"] {
        if compact.starts_with(w) && compact.chars().count() <= 30 {
            return Some(compact);
        }
    }
    // Chapter N（英文书/翻译书）
    let lower = compact.to_ascii_lowercase();
    if lower.starts_with("chapter")
        && compact[7..]
            .chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
    {
        return Some(compact);
    }
    // 第N章/卷/回/部（数字或中文数字）
    if let Some(rest) = compact.strip_prefix('第') {
        let num_len: usize = rest
            .chars()
            .take_while(|&c| is_num_char(c))
            .map(|c| c.len_utf8())
            .sum();
        if num_len > 0 {
            let after = &rest[num_len..];
            if let Some(unit) = after.chars().next() {
                if matches!(unit, '章' | '卷' | '回' | '部') {
                    return Some(compact);
                }
                // 「节/集」容易被「第一节课」之类误伤：仅当后面跟分隔符或结束才认
                if matches!(unit, '节' | '集') {
                    let rem = &after[unit.len_utf8()..];
                    if rem.is_empty() || rem.chars().next().map(is_sep).unwrap_or(false) {
                        return Some(compact);
                    }
                }
            }
        }
    }
    None
}

fn is_num_char(c: char) -> bool {
    c.is_ascii_digit()
        || ('０'..='９').contains(&c)
        || matches!(
            c,
            '零' | '〇' | '一' | '二' | '三' | '四' | '五' | '六' | '七' | '八' | '九' | '十'
                | '百' | '千' | '万' | '两' | '壹' | '贰' | '叁' | '肆' | '伍' | '陆' | '柒'
                | '捌' | '玖' | '拾'
        )
}

fn is_sep(c: char) -> bool {
    matches!(c, '：' | ':' | '、' | '。' | '—' | '-' | '·' | '，' | ',')
}

/// 纯文本 → 编辑器 HTML：每个非空行一个 <p>
fn text_to_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        out.push_str("<p>");
        for c in t.chars() {
            match c {
                '&' => out.push_str("&amp;"),
                '<' => out.push_str("&lt;"),
                '>' => out.push_str("&gt;"),
                _ => out.push(c),
            }
        }
        out.push_str("</p>");
    }
    out
}

// ---------- epub ----------

struct OpfMeta {
    title: Option<String>,
    items: HashMap<String, String>, // id → href（仅 html 类资源）
    spine: Vec<String>,             // idref 阅读顺序
}

fn parse_epub(
    path: &Path,
    fallback_name: &str,
) -> Result<(String, Vec<RawChapter>, String)> {
    let file = std::fs::File::open(path).context("打开 epub 失败")?;
    let mut zip = zip::ZipArchive::new(file).context("epub 不是有效的压缩包")?;
    let container = read_zip_text(&mut zip, "META-INF/container.xml")?;
    let opf_path = find_attr_value(&container, "full-path")
        .ok_or_else(|| anyhow!("container.xml 里找不到 OPF 路径"))?;
    let opf = read_zip_text(&mut zip, &opf_path)?;
    let meta = parse_opf(&opf);
    let base = opf_path
        .rfind('/')
        .map(|i| &opf_path[..i + 1])
        .unwrap_or("");

    let mut chapters = Vec::new();
    for (idx, idref) in meta.spine.iter().enumerate() {
        let Some(href) = meta.items.get(idref) else { continue };
        let entry = format!("{}{}", base, percent_decode(href));
        let Ok(html) = read_zip_text(&mut zip, &entry) else {
            continue;
        };
        let text = html_to_plain(&html);
        if text.trim().chars().count() < 30 {
            continue; // 封面/版权/目录页
        }
        let title = extract_first_tag_text(&html, &["h1", "h2", "h3"])
            .or_else(|| extract_first_tag_text(&html, &["title"]))
            .unwrap_or_else(|| format!("第 {} 节", idx + 1));
        chapters.push(RawChapter { title, text });
    }
    let name = meta
        .title
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| fallback_name.to_string());
    Ok((name, chapters, "epub".to_string()))
}

fn read_zip_text(zip: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Result<String> {
    let mut f = zip
        .by_name(name)
        .with_context(|| format!("压缩包内找不到 {name}"))?;
    let mut buf = Vec::with_capacity(f.size() as usize);
    f.read_to_end(&mut buf)?;
    Ok(decode_text(&buf))
}

/// container.xml 里取 rootfile 的 full-path（属性值扫描，兼容单双引号）
fn find_attr_value(xml: &str, attr: &str) -> Option<String> {
    for q in ['"', '\''] {
        let pat = format!("{attr}={q}");
        if let Some(i) = xml.find(&pat) {
            let start = i + pat.len();
            let end = xml[start..].find(q)?;
            return Some(xml[start..start + end].to_string());
        }
    }
    None
}

fn parse_opf(xml: &str) -> OpfMeta {
    let mut meta = OpfMeta {
        title: None,
        items: HashMap::new(),
        spine: Vec::new(),
    };
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut in_title = false;
    loop {
        use quick_xml::events::Event;
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                match e.local_name().as_ref() {
                    b"item" => {
                        let (mut id, mut href, mut media) =
                            (String::new(), String::new(), String::new());
                        for a in e.attributes().flatten() {
                            let v = String::from_utf8_lossy(a.value.as_ref()).into_owned();
                            match a.key.as_ref() {
                                b"id" => id = v,
                                b"href" => href = decode_entities(&v),
                                b"media-type" => media = v,
                                _ => {}
                            }
                        }
                        if !id.is_empty() && !href.is_empty() && media.contains("html") {
                            meta.items.insert(id, href);
                        }
                    }
                    b"itemref" => {
                        for a in e.attributes().flatten() {
                            if a.key.as_ref() == b"idref" {
                                meta.spine
                                    .push(String::from_utf8_lossy(a.value.as_ref()).into_owned());
                            }
                        }
                    }
                    b"title" => in_title = true, // dc:title（Empty 的 title 无文本，置 true 无害）
                    _ => {}
                }
            }
            Ok(Event::Text(t)) if in_title && meta.title.is_none() => {
                let s = decode_entities(&String::from_utf8_lossy(t.as_ref()));
                if !s.trim().is_empty() {
                    meta.title = Some(s.trim().to_string());
                }
            }
            Ok(Event::End(e)) => {
                if e.local_name().as_ref() == b"title" {
                    in_title = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    meta
}

/// epub 正文 HTML → 纯文本：删 script/style，块级标签转换行，剥标签，解实体
fn html_to_plain(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut cleaned = String::with_capacity(html.len());
    let mut rest = 0usize;
    loop {
        let s1 = lower[rest..].find("<script");
        let s2 = lower[rest..].find("<style");
        let start = match (s1, s2) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (None, None) => {
                cleaned.push_str(&html[rest..]);
                break;
            }
        };
        let abs = rest + start;
        cleaned.push_str(&html[rest..abs]);
        let close = if lower[abs..].starts_with("<script") {
            "</script>"
        } else {
            "</style>"
        };
        match lower[abs..].find(close) {
            Some(i) => rest = abs + i + close.len(),
            None => break,
        }
    }
    let mut out = String::with_capacity(cleaned.len());
    let mut in_tag = false;
    let mut tag = String::new();
    for c in cleaned.chars() {
        match c {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' => {
                if in_tag {
                    let name = tag
                        .trim()
                        .trim_start_matches('/')
                        .split(|c: char| c.is_whitespace() || c == '/')
                        .next()
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    if matches!(
                        name.as_str(),
                        "p" | "div" | "br" | "hr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                            | "li" | "tr" | "section" | "article" | "blockquote" | "table"
                            | "ul" | "ol" | "header" | "footer" | "aside" | "img" | "svg"
                    ) {
                        out.push('\n');
                    }
                    in_tag = false;
                }
            }
            _ if in_tag => {
                if tag.len() < 32 {
                    tag.push(c);
                }
            }
            _ => out.push(c),
        }
    }
    let decoded = decode_entities(&out);
    decoded
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// 取首个指定标签的 inner text（epub 章节标题用），超长截断
fn extract_first_tag_text(html: &str, tags: &[&str]) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    for t in tags {
        let open = format!("<{t}");
        if let Some(i) = lower.find(&open) {
            let after = i + open.len();
            // 标签名后必须是 > 或空白，排除 <h1x 之类
            let Some(c) = lower[after..].chars().next() else { continue };
            if c != '>' && !c.is_whitespace() {
                continue;
            }
            let Some(gt) = lower[after..].find('>') else { continue };
            let start = after + gt + 1;
            let close = format!("</{t}>");
            if let Some(j) = lower[start..].find(&close) {
                let inner = html_to_plain(&html[start..start + j]);
                let inner = inner.trim();
                if !inner.is_empty() {
                    return Some(inner.chars().take(60).collect());
                }
            }
        }
    }
    None
}

// ---------- docx ----------

fn read_docx_text(path: &Path) -> Result<String> {
    let file = std::fs::File::open(path).context("打开 docx 失败")?;
    let mut zip = zip::ZipArchive::new(file).context("docx 不是有效的压缩包")?;
    let xml = read_zip_text(&mut zip, "word/document.xml")?;
    Ok(docx_xml_to_text(&xml))
}

/// word/document.xml → 纯文本：段落/换行/制表符转换行后剥标签、解实体
fn docx_xml_to_text(xml: &str) -> String {
    let pre = xml
        .replace("<w:tab/>", "\t")
        .replace("<w:tab />", "\t")
        .replace("<w:br/>", "\n")
        .replace("<w:br />", "\n")
        .replace("</w:p>", "\n");
    let mut out = String::with_capacity(pre.len());
    let mut in_tag = false;
    for c in pre.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    decode_entities(&out)
}

// ---------- 公共小工具 ----------

/// HTML/XML 实体解码：常见命名实体 + 十/十六进制数字实体
fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let after = &rest[i..];
        let mut consumed = false;
        if let Some(j) = after.find(';') {
            if j <= 12 {
                let ent = &after[1..j];
                let rep = match ent {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some(' '),
                    "hellip" => Some('…'),
                    "mdash" => Some('—'),
                    "ndash" => Some('–'),
                    "ldquo" => Some('\u{201C}'),
                    "rdquo" => Some('\u{201D}'),
                    "lsquo" => Some('\u{2018}'),
                    "rsquo" => Some('\u{2019}'),
                    _ => ent.strip_prefix('#').and_then(|num| {
                        let code = match num.strip_prefix(['x', 'X']) {
                            Some(hex) => u32::from_str_radix(hex, 16).ok(),
                            None => num.parse::<u32>().ok(),
                        };
                        code.and_then(char::from_u32)
                    }),
                };
                if let Some(c) = rep {
                    out.push(c);
                    rest = &after[j + 1..];
                    consumed = true;
                }
            }
        }
        if !consumed {
            out.push('&');
            rest = &after[1..];
        }
    }
    out.push_str(rest);
    out
}

/// epub href 的百分号解码（%XX → 字节，再按 UTF-8 还原）
fn percent_decode(s: &str) -> String {
    if !s.contains('%') {
        return s.to_string();
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 3 <= bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(n: usize) -> String {
        "这是一段正文内容，用来凑够章节的最小长度。".repeat(n)
    }

    #[test]
    fn splits_numbered_chapters() {
        let text = format!("第一章 重生\n{}\n第二章 觉醒\n{}", body(2), body(2));
        let chs = split_text_chapters(&text);
        assert_eq!(chs.len(), 2);
        assert_eq!(chs[0].title, "第一章重生"); // 空格归并，标题取整行
        assert_eq!(chs[1].title, "第二章觉醒");
    }

    #[test]
    fn keeps_preamble_as_related() {
        let text = format!("{}\n第一章 开始\n{}", body(10), body(2));
        let chs = split_text_chapters(&text);
        assert_eq!(chs.len(), 2);
        assert_eq!(chs[0].title, "作品相关");
        assert_eq!(chs[1].title, "第一章开始");
    }

    #[test]
    fn drops_toc_shells() {
        // 开头目录页（标题后无正文） + 正文重复标题
        let text = format!(
            "第一章 起\n第二章 承\n第一章 起\n{}\n第二章 承\n{}",
            body(2),
            body(2)
        );
        let chs = split_text_chapters(&text);
        assert_eq!(chs.len(), 2);
        assert_eq!(chs[0].title, "第一章起");
        assert!(chs[0].text.contains("正文"));
    }

    #[test]
    fn rejects_prose_lookalike() {
        // 「第一节课」这类正文行不能误判成标题
        let text = format!("第一节课他没有来，教室里空荡荡的。\n{}", body(2));
        let chs = split_text_chapters(&text);
        assert_eq!(chs.len(), 1);
        assert_eq!(chs[0].title, "全文");
    }

    #[test]
    fn special_headings() {
        let text = format!("楔子\n{}\n番外 十年之后\n{}", body(2), body(2));
        let chs = split_text_chapters(&text);
        assert_eq!(chs.len(), 2);
        assert_eq!(chs[0].title, "楔子");
        assert_eq!(chs[1].title, "番外十年之后");
    }

    #[test]
    fn gbk_fallback_decoding() {
        let s = "第一章 你好世界\n正文内容。";
        let (bytes, _, _) = encoding_rs::GB18030.encode(s);
        assert_eq!(decode_text(&bytes), s);
    }

    #[test]
    fn chunks_when_no_headings() {
        let para = body(1);
        let mut text = String::new();
        for _ in 0..3000 {
            text.push_str(&para);
            text.push_str("\n\n");
        }
        let chs = split_text_chapters(&text);
        assert!(chs.len() > 1);
        assert!(chs[0].title.starts_with("未分章"));
    }

    #[test]
    fn decodes_entities() {
        assert_eq!(decode_entities("a&amp;b&#x2014;c&#65;&hellip;"), "a&b—cA…");
        assert_eq!(decode_entities("没有实体"), "没有实体");
    }

    #[test]
    fn docx_xml_extracts_paragraphs() {
        let xml = r#"<w:document><w:body><w:p><w:r><w:t>第一段&amp;测试</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>"#;
        let text = docx_xml_to_text(xml);
        assert!(text.contains("第一段&测试"));
        assert!(text.contains("\n第二段"));
    }

    #[test]
    fn epub_html_to_plain() {
        let html = "<html><head><style>p{color:red}</style></head><body><h1>第五章 夜战</h1><p>第一段&amp;说明。</p><p>第二段。</p><script>var x=1;</script></body></html>";
        assert_eq!(
            extract_first_tag_text(html, &["h1", "h2"]).as_deref(),
            Some("第五章 夜战")
        );
        let text = html_to_plain(html);
        assert!(text.contains("第一段&说明。"));
        assert!(text.contains("第二段。"));
        assert!(!text.contains("var x"));
        assert!(!text.contains("color"));
    }

    /// 造一个最小 zip 到临时目录，返回路径（测试结束调用方删除）
    fn make_zip(name: &str, entries: &[(&str, &str)]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("novel-studio-test-{name}-{}", std::process::id()));
        let file = std::fs::File::create(&path).unwrap();
        let mut zw = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (n, content) in entries {
            zw.start_file(*n, opts).unwrap();
            std::io::Write::write_all(&mut zw, content.as_bytes()).unwrap();
        }
        zw.finish().unwrap();
        path
    }

    #[test]
    fn parses_minimal_epub() {
        let container = r#"<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#;
        let opf = r#"<?xml version="1.0"?><package><metadata><dc:title>测试之书</dc:title></metadata>
            <manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest>
            <spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>"#;
        let ch1 = "<html><body><h1>第一章 开始</h1><p>第一章的正文内容，长度足够不会被过滤掉，再补一句凑够三十个字符。</p></body></html>";
        let ch2 = "<html><body><h2>第二章 继续</h2><p>第二章的正文内容，同样长度足够不会被过滤掉，再补一句凑够三十个字符。</p></body></html>";
        let path = make_zip("epub", &[
            ("META-INF/container.xml", container),
            ("OEBPS/content.opf", opf),
            ("OEBPS/ch1.xhtml", ch1),
            ("OEBPS/ch2.xhtml", ch2),
        ]);
        let (name, chs, _) = parse_epub(&path, "兜底名").unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(name, "测试之书");
        assert_eq!(chs.len(), 2);
        assert_eq!(chs[0].title, "第一章 开始");
        assert!(chs[1].text.contains("第二章的正文内容"));
    }

    #[test]
    fn parses_minimal_docx() {
        let document = "<w:document><w:body><w:p><w:r><w:t>第一章 标题</w:t></w:r></w:p><w:p><w:r><w:t>正文第一段，长度足够不会被过滤掉的正文内容，再补一句凑够三十个字符。</w:t></w:r></w:p></w:body></w:document>";
        let path = make_zip("docx", &[("word/document.xml", document)]);
        let text = read_docx_text(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        let chs = split_text_chapters(&text);
        assert_eq!(chs.len(), 1);
        assert_eq!(chs[0].title, "第一章标题");
        assert!(chs[0].text.contains("正文第一段"));
    }
}
