use super::download::{DocumentMeta, TempFileGuard};
use super::multimodal::common::download_binary_to_temp;
use flate2::read::GzDecoder;
use std::io::Read;
use std::path::Path;
use tar::Archive as TarArchive;
use zip::ZipArchive;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArchiveKind {
    Zip,
    Tar,
    TarGz,
    Gz,
}

fn guess_kind(url: &str, file_name: Option<&str>) -> Option<ArchiveKind> {
    let name = file_name
        .or_else(|| url.split('/').last())
        .unwrap_or("")
        .trim()
        .to_lowercase();

    if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        return Some(ArchiveKind::TarGz);
    }
    if name.ends_with(".tar") {
        return Some(ArchiveKind::Tar);
    }
    if name.ends_with(".zip") {
        return Some(ArchiveKind::Zip);
    }
    if name.ends_with(".gz") {
        return Some(ArchiveKind::Gz);
    }
    None
}

fn normalize_keywords(keywords: &[String]) -> Vec<String> {
    keywords
        .iter()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

fn choose_best_file<'a>(candidates: &'a [ExtractCandidate], keywords: &[String]) -> Option<&'a ExtractCandidate> {
    if candidates.is_empty() {
        return None;
    }

    let kw = normalize_keywords(keywords);

    let mut best: Option<(&ExtractCandidate, i64)> = None;
    for c in candidates {
        let mut score: i64 = 0;
        let name = c.name.to_lowercase();

        if name.ends_with("latest.log") {
            score += 200;
        }
        if name.contains("crash") || name.contains("hs_err") {
            score += 150;
        }
        if name.ends_with(".log") {
            score += 40;
        }
        if name.ends_with(".txt") {
            score += 20;
        }

        for k in &kw {
            if name == *k {
                score += 500;
            } else if name.contains(k) {
                score += 80;
            }
        }

        // Prefer larger files if scores tie (more context), but keep stable.
        score += (c.size_bytes.min(5_000_000) as i64) / 50_000;

        match best {
            None => best = Some((c, score)),
            Some((_, s)) if score > s => best = Some((c, score)),
            _ => {}
        }
    }

    best.map(|(c, _)| c)
}

fn truncate_to_chars(s: String, max_chars: usize) -> (String, bool) {
    if s.chars().count() <= max_chars {
        return (s, false);
    }
    let out: String = s.chars().take(max_chars).collect();
    (out, true)
}

#[derive(Debug, Clone)]
struct ExtractCandidate {
    name: String,
    size_bytes: u64,
}

fn is_text_candidate_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".log") || lower.ends_with(".txt")
}

fn read_limited_to_vec<R: Read>(mut r: R, max_bytes: u64) -> Result<(Vec<u8>, bool), String> {
    let mut buf: Vec<u8> = Vec::new();
    let mut truncated = false;
    let max = max_bytes as usize;
    let mut chunk = [0u8; 8192];
    loop {
        let n = r.read(&mut chunk).map_err(|e| format!("read failed: {e}"))?;
        if n == 0 {
            break;
        }
        if buf.len() + n > max {
            let remain = max.saturating_sub(buf.len());
            buf.extend_from_slice(&chunk[..remain]);
            truncated = true;
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Ok((buf, truncated))
}

fn extract_best_text_from_zip(
    path: &Path,
    max_extract_bytes: u64,
    max_file_bytes: u64,
    max_files: u32,
    keywords: &[String],
) -> Result<(String, Option<String>, u64, bool), String> {
    let file = std::fs::File::open(path).map_err(|e| format!("open zip failed: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("parse zip failed: {e}"))?;

    let mut candidates: Vec<ExtractCandidate> = Vec::new();
    for i in 0..archive.len() {
        let f = archive
            .by_index(i)
            .map_err(|e| format!("read zip entry failed: {e}"))?;
        if f.is_dir() {
            continue;
        }
        let name = f.name().to_string();
        if !is_text_candidate_name(&name) {
            continue;
        }
        candidates.push(ExtractCandidate {
            name,
            size_bytes: f.size(),
        });
        if candidates.len() as u32 >= max_files {
            break;
        }
    }

    let Some(best) = choose_best_file(&candidates, keywords) else {
        return Err("压缩包内未找到 .log/.txt 文件".to_string());
    };

    let mut total_extracted: u64 = 0;
    let mut file = archive
        .by_name(&best.name)
        .map_err(|e| format!("open zip entry failed: {e}"))?;
    let allowed = max_file_bytes.min(max_extract_bytes);
    let (bytes, truncated_bytes) = read_limited_to_vec(&mut file, allowed)?;
    total_extracted += bytes.len() as u64;

    let text = String::from_utf8_lossy(&bytes).to_string();
    // Keep some extra headroom for prompt wrapper and metadata; plugin can further truncate.
    let (text, truncated_chars) = truncate_to_chars(text, 200_000);
    let truncated = truncated_bytes || truncated_chars || total_extracted >= max_extract_bytes;
    let ext = Path::new(&best.name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase());
    Ok((text, ext, total_extracted, truncated))
}

fn extract_best_text_from_tar_path(
    path: &Path,
    gz: bool,
    max_extract_bytes: u64,
    max_file_bytes: u64,
    max_files: u32,
    keywords: &[String],
) -> Result<(String, Option<String>, u64, bool), String> {
    // First pass: collect candidates.
    let file = std::fs::File::open(path).map_err(|e| format!("open tar failed: {e}"))?;
    let reader: Box<dyn Read> = if gz {
        Box::new(GzDecoder::new(file))
    } else {
        Box::new(file)
    };
    let mut archive = TarArchive::new(reader);

    let mut candidates: Vec<ExtractCandidate> = Vec::new();
    let entries = archive.entries().map_err(|e| format!("parse tar failed: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read tar entry failed: {e}"))?;
        let header = entry.header();
        if header.entry_type().is_dir() {
            continue;
        }
        let p = entry
            .path()
            .map_err(|e| format!("read tar entry path failed: {e}"))?;
        let name = p.to_string_lossy().to_string();
        if !is_text_candidate_name(&name) {
            continue;
        }
        candidates.push(ExtractCandidate {
            name,
            size_bytes: header.size().unwrap_or(0),
        });
        if candidates.len() as u32 >= max_files {
            break;
        }
    }

    let Some(best) = choose_best_file(&candidates, keywords) else {
        return Err("压缩包内未找到 .log/.txt 文件".to_string());
    };

    // Second pass: read chosen entry.
    let file = std::fs::File::open(path).map_err(|e| format!("open tar failed: {e}"))?;
    let reader: Box<dyn Read> = if gz {
        Box::new(GzDecoder::new(file))
    } else {
        Box::new(file)
    };
    let mut archive = TarArchive::new(reader);

    let mut total_extracted: u64 = 0;
    let entries = archive.entries().map_err(|e| format!("parse tar failed: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("read tar entry failed: {e}"))?;
        let header = entry.header();
        if header.entry_type().is_dir() {
            continue;
        }
        let p = entry
            .path()
            .map_err(|e| format!("read tar entry path failed: {e}"))?;
        let name = p.to_string_lossy().to_string();
        if name != best.name {
            continue;
        }

        let allowed = max_file_bytes.min(max_extract_bytes);
        let (bytes, truncated_bytes) = read_limited_to_vec(&mut entry, allowed)?;
        total_extracted += bytes.len() as u64;
        let text = String::from_utf8_lossy(&bytes).to_string();
        let (text, truncated_chars) = truncate_to_chars(text, 200_000);
        let truncated = truncated_bytes || truncated_chars || total_extracted >= max_extract_bytes;
        let ext = Path::new(&best.name)
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase());
        return Ok((text, ext, total_extracted, truncated));
    }

    Err("压缩包内未找到可用日志文件".to_string())
}

fn extract_best_text_from_gz_path(
    path: &Path,
    max_extract_bytes: u64,
    max_file_bytes: u64,
) -> Result<(String, Option<String>, u64, bool), String> {
    let file = std::fs::File::open(path).map_err(|e| format!("open gz failed: {e}"))?;
    let mut decoder = GzDecoder::new(file);

    let allowed = max_file_bytes.min(max_extract_bytes);
    let (bytes, truncated_bytes) = read_limited_to_vec(&mut decoder, allowed)?;
    let text = String::from_utf8_lossy(&bytes).to_string();
    let (text, truncated_chars) = truncate_to_chars(text, 200_000);
    let truncated = truncated_bytes || truncated_chars;
    Ok((text, Some("gz".to_string()), bytes.len() as u64, truncated))
}

pub(super) async fn download_archive_text(
    url: &str,
    file_name: Option<&str>,
    timeout_ms: u64,
    max_download_bytes: u64,
    max_extract_bytes: u64,
    max_file_bytes: u64,
    max_files: u32,
    keywords: &[String],
) -> Result<(TempFileGuard, String, DocumentMeta), String> {
    let (guard, bin_meta) = download_binary_to_temp(url, file_name, timeout_ms, max_download_bytes).await?;

    let kind = guess_kind(url, bin_meta.file_name.as_deref().or(file_name)).ok_or_else(|| {
        "不支持的压缩格式（仅支持 .zip / .tar / .tar.gz(.tgz) / .gz）".to_string()
    })?;

    let path = guard.path.clone();
    let keywords = keywords.to_vec();
    let max_extract_bytes = max_extract_bytes.clamp(1_000_000, 1_000_000_000);
    let max_file_bytes = max_file_bytes.clamp(100_000, 200_000_000);
    let max_files = max_files.clamp(1, 500);

    let (text, ext, extracted_bytes, truncated) = tokio::task::spawn_blocking(move || {
        match kind {
            ArchiveKind::Zip => extract_best_text_from_zip(
                &path,
                max_extract_bytes,
                max_file_bytes,
                max_files,
                &keywords,
            ),
            ArchiveKind::Tar => extract_best_text_from_tar_path(
                &path,
                false,
                max_extract_bytes,
                max_file_bytes,
                max_files,
                &keywords,
            ),
            ArchiveKind::TarGz => extract_best_text_from_tar_path(
                &path,
                true,
                max_extract_bytes,
                max_file_bytes,
                max_files,
                &keywords,
            ),
            ArchiveKind::Gz => extract_best_text_from_gz_path(&path, max_extract_bytes, max_file_bytes),
        }
    })
    .await
    .map_err(|e| format!("解压任务失败: {e}"))??;

    let meta = DocumentMeta {
        title: String::new(),
        file_ext: ext,
        size_bytes: Some(extracted_bytes),
        truncated: truncated || bin_meta.truncated,
    };

    Ok((guard, text, meta))
}
