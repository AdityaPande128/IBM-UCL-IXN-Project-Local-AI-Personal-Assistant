use std::fs;
use std::path::PathBuf;

fn token_path(configured: Option<String>) -> PathBuf {
    let home = || PathBuf::from(std::env::var("HOME").unwrap_or_default());
    match configured {
        Some(p) if !p.is_empty() => match p.strip_prefix("~/") {
            Some(rest) => home().join(rest),
            None => PathBuf::from(p),
        },
        _ => home().join(".jarvis").join("socket-token"),
    }
}

#[tauri::command]
fn socket_token(path: Option<String>) -> Result<String, String> {
    fs::read_to_string(token_path(path))
        .map(|t| t.trim().to_string())
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![socket_token])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
