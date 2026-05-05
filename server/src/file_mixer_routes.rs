//! File mixer REST endpoints — mix audio tracks server-side via ffmpeg.
use std::path::{Path, PathBuf};
use axum::{
    body::Body,
    extract::{Path as AxumPath, State},
    http::{header, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tokio::fs;
use crate::ws_server::WsServerState;

const TRACKS_DIR: &str = "./tracks";
const MIXED_DIR: &str = "./mixed";

#[derive(Serialize)]
struct TrackInfo {
    name: String,
    size: u64,
}

#[derive(Deserialize)]
pub struct TrackVolume {
    pub name: String,
    pub volume: f64,   // 0.0 – 2.0
    pub muted: Option<bool>,
}

#[derive(Deserialize)]
pub struct MixRequest {
    pub tracks: Vec<TrackVolume>,
    pub normalize: Option<bool>,
    pub duration_mode: Option<String>,  // "shortest" | "longest" | "first"
}

#[derive(Deserialize)]
pub struct SaveRequest {
    pub tracks: Vec<TrackVolume>,
    pub filename: String,
    pub normalize: Option<bool>,
}

pub fn file_mixer_router() -> Router<WsServerState> {
    Router::new()
        .route("/api/mixer/tracks", get(list_tracks))
        .route("/api/mixer/tracks/{name}", get(serve_track))
        .route("/api/mixer/mix", post(mix_tracks))
        .route("/api/mixer/save", post(save_mix))
}

async fn list_tracks() -> impl IntoResponse {
    let Ok(mut dir) = fs::read_dir(TRACKS_DIR).await else {
        return (StatusCode::OK, Json(Vec::<TrackInfo>::new())).into_response();
    };
    let mut tracks = Vec::new();
    while let Ok(Some(entry)) = dir.next_entry().await {
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        if !["mp3", "wav", "ogg", "flac", "m4a", "aac"].contains(&ext.as_str()) { continue; }
        let size = fs::metadata(&path).await.map(|m| m.len()).unwrap_or(0);
        tracks.push(TrackInfo { name: entry.file_name().to_string_lossy().into_owned(), size });
    }
    tracks.sort_by(|a, b| a.name.cmp(&b.name));
    Json(tracks).into_response()
}

async fn serve_track(AxumPath(name): AxumPath<String>) -> impl IntoResponse {
    if name.contains('/') || name.contains('\\') || name.starts_with('.') {
        return (StatusCode::BAD_REQUEST, "invalid name").into_response();
    }
    let path = PathBuf::from(TRACKS_DIR).join(&name);
    match fs::read(&path).await {
        Ok(bytes) => {
            let mime = mime_for(&name);
            ([(header::CONTENT_TYPE, mime)], bytes).into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "track not found").into_response(),
    }
}

async fn mix_tracks(Json(req): Json<MixRequest>) -> impl IntoResponse {
    match run_mix(&req.tracks, req.normalize.unwrap_or(false), req.duration_mode.as_deref()).await {
        Ok(mp3_bytes) => {
            let headers = [(header::CONTENT_TYPE, "audio/mpeg"),
                           (header::CONTENT_DISPOSITION, "inline; filename=\"mix.mp3\"")];
            (headers, mp3_bytes).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

async fn save_mix(Json(req): Json<SaveRequest>) -> impl IntoResponse {
    let filename = sanitize_filename(&req.filename);
    if filename.is_empty() {
        return (StatusCode::BAD_REQUEST, "invalid filename").into_response();
    }
    match run_mix(&req.tracks, req.normalize.unwrap_or(false), None).await {
        Ok(mp3_bytes) => {
            if let Err(e) = fs::create_dir_all(MIXED_DIR).await {
                return (StatusCode::INTERNAL_SERVER_ERROR, format!("mkdir failed: {e}")).into_response();
            }
            let out_path = PathBuf::from(MIXED_DIR).join(&filename);
            if let Err(e) = fs::write(&out_path, &mp3_bytes).await {
                return (StatusCode::INTERNAL_SERVER_ERROR, format!("write failed: {e}")).into_response();
            }
            Json(serde_json::json!({"ok": true, "filename": filename})).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

async fn run_mix(tracks: &[TrackVolume], normalize: bool, duration_mode: Option<&str>) -> Result<Vec<u8>, String> {
    if tracks.is_empty() { return Err("no tracks".into()); }

    let active: Vec<&TrackVolume> = tracks.iter().filter(|t| !t.muted.unwrap_or(false)).collect();
    if active.is_empty() { return Err("all tracks muted".into()); }

    // Build ffmpeg argument list
    let mut args: Vec<String> = vec!["-y".into()];

    for t in &active {
        if t.name.contains('/') || t.name.contains('\\') || t.name.starts_with('.') {
            return Err(format!("invalid track name: {}", t.name));
        }
        let path = PathBuf::from(TRACKS_DIR).join(&t.name);
        if !path.exists() { return Err(format!("track not found: {}", t.name)); }
        args.push("-i".into());
        args.push(path.to_string_lossy().into_owned());
    }

    // Build filter_complex: apply volume to each input, then amix
    let mut filter_parts = Vec::new();
    for (i, t) in active.iter().enumerate() {
        let vol = t.volume.clamp(0.0, 4.0);
        filter_parts.push(format!("[{}:a]volume={:.3}[a{}]", i, vol, i));
    }
    let inputs: String = (0..active.len()).map(|i| format!("[a{}]", i)).collect();
    let dur = duration_mode.unwrap_or("longest");
    let mix_filter = if active.len() == 1 {
        format!("[a0]anull[out]")
    } else {
        format!("{}amix=inputs={}:duration={}:normalize={}[out]",
            inputs, active.len(), dur, if normalize { 1 } else { 0 })
    };

    let full_filter = if filter_parts.is_empty() {
        mix_filter
    } else {
        format!("{};{}", filter_parts.join(";"), mix_filter)
    };

    args.push("-filter_complex".into());
    args.push(full_filter);
    args.push("-map".into());
    args.push("[out]".into());
    args.push("-f".into());
    args.push("mp3".into());
    args.push("-b:a".into());
    args.push("192k".into());
    args.push("pipe:1".into());

    let output = Command::new("ffmpeg")
        .args(&args)
        .output()
        .await
        .map_err(|e| format!("ffmpeg spawn failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg error: {}", &stderr[stderr.len().saturating_sub(800)..]))
    }

    Ok(output.stdout)
}

fn mime_for(name: &str) -> &'static str {
    let ext = Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    match ext.as_str() {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" | "aac" => "audio/aac",
        _ => "application/octet-stream",
    }
}

fn sanitize_filename(name: &str) -> String {
    let s: String = name.chars().filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '.').collect();
    if s.ends_with(".mp3") { s } else { format!("{}.mp3", s) }
}
