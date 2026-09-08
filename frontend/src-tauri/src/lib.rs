use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

fn token_path(configured: Option<String>) -> PathBuf {
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
    let resolved = token_path(path);
    let named = resolved.file_name().map(|n| n == "socket-token").unwrap_or(false);
    let at_home = resolved.starts_with(home());
    if !named || !at_home {
        return Err("token path must be a socket-token file under the home directory".to_string());
    }
    fs::read_to_string(resolved)
        .map(|t| t.trim().to_string())
        .map_err(|e| e.to_string())
}

// The menu-bar half of the mic-privacy contract: whenever the microphone is
// open for "Hey Jarvis", a dot shows in the menu bar — outside the app's own
// window, visible even when the window is hidden. The dot and the mic are
// switched by the same call, so one cannot be on without the other showing.
#[tauri::command]
fn set_wake_indicator(app: AppHandle, listening: bool) {
    if let Some(tray) = app.tray_by_id("jarvis") {
        let _ = tray.set_title(if listening { Some("●") } else { None::<&str> });
        let _ = tray.set_tooltip(Some(if listening {
            "Jarvis is listening for \u{201c}Hey Jarvis\u{201d} — the microphone is open"
        } else {
            "Jarvis — microphone off"
        }));
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Jarvis", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Jarvis", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut tray = TrayIconBuilder::with_id("jarvis")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Jarvis — microphone off")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone()).icon_as_template(true);
    }
    tray.build(app)?;
    Ok(())
}

#[derive(Clone, Deserialize)]
struct ServiceSpec {
    name: String,
    argv: Vec<String>,
    cwd: String,
    port: u16,
    #[serde(default)]
    log_max_bytes: Option<u64>,
}

#[derive(Default)]
struct Supervisor {
    pids: Arc<Mutex<HashMap<String, u32>>>,
    started: Arc<Mutex<bool>>,
    quitting: Arc<AtomicBool>,
}

fn logs_dir() -> PathBuf {
    let dir = home().join(".jarvis").join("logs");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn rotate_log(path: &PathBuf, max_bytes: u64) {
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() > max_bytes {
            let mut rolled = path.clone().into_os_string();
            rolled.push(".1");
            let _ = fs::rename(path, rolled);
        }
    }
}

// A Finder launch starts at "/", so the current directory only finds the
// repo in dev; the bundled app falls back to its own executable's ancestry,
// and an installed copy to where it was built.
fn project_root() -> PathBuf {
    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = std::env::current_dir() {
        starts.push(dir);
    }
    if let Ok(exe) = std::env::current_exe() {
        starts.push(exe);
    }
    starts.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    for start in starts {
        let mut dir = start;
        loop {
            if dir.join("config.json").is_file() {
                return dir;
            }
            if !dir.pop() {
                break;
            }
        }
    }
    std::env::current_dir().unwrap_or_default()
}

// A Finder launch carries only the system PATH; the user's login shell
// knows where the runtimes actually live, so ask it once.
fn augmented_path() -> String {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        // The runtimes live where the user's real shell puts them: conda and
        // friends initialise in .zshrc, which only an interactive shell
        // reads. Markers keep rc noise out of the harvested value.
        let interactive = Command::new("/bin/zsh")
            .args(["-lic", "printf '@@%s@@' \"$PATH\""])
            .output()
            .ok()
            .filter(|out| out.status.success())
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .and_then(|raw| {
                let start = raw.find("@@")? + 2;
                let end = raw[start..].find("@@")? + start;
                Some(raw[start..end].to_string())
            })
            .filter(|p| !p.trim().is_empty());

        let mut path = interactive
            .or_else(|| {
                Command::new("/bin/zsh")
                    .args(["-lc", "printf %s \"$PATH\""])
                    .output()
                    .ok()
                    .filter(|out| out.status.success())
                    .and_then(|out| String::from_utf8(out.stdout).ok())
                    .filter(|p| !p.trim().is_empty())
            })
            .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
        for extra in ["/opt/homebrew/bin", "/usr/local/bin"] {
            if !path.split(':').any(|p| p == extra) {
                path = format!("{path}:{extra}");
            }
        }
        path
    })
    .clone()
}

fn resolve_program(name: &str) -> PathBuf {
    if name.contains('/') {
        return PathBuf::from(name);
    }
    for dir in augmented_path().split(':') {
        let candidate = PathBuf::from(dir).join(name);
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from(name)
}

fn port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

fn emit_status(app: &AppHandle, name: &str, status: &str, restarts: u32) {
    let _ = app.emit(
        "service-status",
        serde_json::json!({ "name": name, "status": status, "restarts": restarts }),
    );
}

fn supervise(
    app: AppHandle,
    spec: ServiceSpec,
    pids: Arc<Mutex<HashMap<String, u32>>>,
    quitting: Arc<AtomicBool>,
) {
    let root = project_root();
    let mut restarts: u32 = 0;

    while !quitting.load(Ordering::Relaxed) {
        if port_open(spec.port) {
            emit_status(&app, &spec.name, "external", restarts);
            while port_open(spec.port) && !quitting.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_secs(5));
            }
            continue;
        }

        emit_status(&app, &spec.name, "starting", restarts);
        let cwd = {
            let p = PathBuf::from(&spec.cwd);
            if p.is_absolute() { p } else { root.join(p) }
        };

        let log_path = logs_dir().join(format!("{}.log", spec.name));
        rotate_log(&log_path, spec.log_max_bytes.unwrap_or(5 * 1024 * 1024));
        let spawned = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .and_then(|log| {
                let err = log.try_clone()?;
                Command::new(resolve_program(&spec.argv[0]))
                    .args(&spec.argv[1..])
                    .current_dir(&cwd)
                    .env("PATH", augmented_path())
                    .stdout(Stdio::from(log))
                    .stderr(Stdio::from(err))
                    .spawn()
            });

        match spawned {
            Ok(mut child) => {
                pids.lock().unwrap().insert(spec.name.clone(), child.id());
                let launched = Instant::now();

                // However long the boot takes, the banner follows the
                // truth: poll until the port opens or the child dies.
                loop {
                    if port_open(spec.port) {
                        emit_status(&app, &spec.name, "running", restarts);
                        break;
                    }
                    if let Ok(Some(_)) = child.try_wait() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }

                let _ = child.wait();
                pids.lock().unwrap().remove(&spec.name);
                if quitting.load(Ordering::Relaxed) {
                    break;
                }

                if launched.elapsed() > Duration::from_secs(60) {
                    restarts = 0;
                }
                restarts += 1;
                emit_status(&app, &spec.name, "restarting", restarts);
                let delay = std::cmp::min(1u64 << std::cmp::min(restarts, 5), 30);
                std::thread::sleep(Duration::from_secs(delay));
            }
            Err(err) => {
                // A spawn that dies before its first byte must still leave
                // a trace, or the failure is invisible from every log.
                let _ = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&log_path)
                    .and_then(|mut log| {
                        use std::io::Write;
                        writeln!(log, "[supervisor] {} failed to spawn: {err}", spec.name)
                    });
                emit_status(&app, &spec.name, "failed", restarts);
                restarts += 1;
                std::thread::sleep(Duration::from_secs(10));
            }
        }
    }
}

#[tauri::command]
fn start_services(app: AppHandle, specs: Vec<ServiceSpec>, supervisor: State<Supervisor>) {
    let mut started = supervisor.started.lock().unwrap();
    if *started {
        return;
    }
    *started = true;

    for spec in specs {
        if spec.argv.is_empty() {
            continue;
        }
        let app = app.clone();
        let pids = supervisor.pids.clone();
        let quitting = supervisor.quitting.clone();
        std::thread::spawn(move || supervise(app, spec, pids, quitting));
    }
}

fn shutdown(supervisor: &Supervisor) {
    supervisor.quitting.store(true, Ordering::Relaxed);
    let pids = supervisor.pids.lock().unwrap();
    for pid in pids.values() {
        let _ = Command::new("kill").arg(pid.to_string()).status();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// The menu bar is the app's discoverability layer: every in-window shortcut
// has a menu item that names it, and the standard Edit menu keeps the
// system clipboard working inside the webview.
fn build_app_menu(app: &AppHandle) -> tauri::Result<()> {
    let settings = MenuItem::with_id(app, "settings", "Settings\u{2026}", true, Some("Cmd+,"))?;
    let app_menu = Submenu::with_items(
        app,
        "Jarvis",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let new_chat = MenuItem::with_id(app, "new-chat", "New Chat", true, Some("Cmd+N"))?;
    let file_menu = Submenu::with_items(app, "File", true, &[&new_chat])?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let sidebar = MenuItem::with_id(app, "toggle-sidebar", "Toggle Sidebar", true, Some("Cmd+B"))?;
    let activity =
        MenuItem::with_id(app, "toggle-activity", "Toggle Activity", true, Some("Alt+Cmd+A"))?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[&sidebar, &activity, &PredefinedMenuItem::separator(app)?,
          &PredefinedMenuItem::fullscreen(app, None)?],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let menu = Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])?;
    app.set_menu(menu)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Supervisor::default())
        .invoke_handler(tauri::generate_handler![
            socket_token,
            start_services,
            set_wake_indicator
        ])
        .setup(|app| {
            build_tray(&app.handle())?;
            build_app_menu(app.handle())?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            if matches!(id, "new-chat" | "settings" | "toggle-sidebar" | "toggle-activity") {
                let _ = app.emit("jarvis-menu", id.to_string());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                shutdown(&app.state::<Supervisor>());
            }
        });
}
