// Say It — Linux port of callebtc/sayit.
// Tauri shell: spawns the pure-JS sidecar, owns the global hotkey and tray,
// and serves the SvelteKit UI.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::path::BaseDirectory;
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

/// Sidecar tree shipped inside the GUI package (`bundle.resources` → `sidecar/`).
static BUNDLED_SIDECAR_DIR: OnceLock<PathBuf> = OnceLock::new();
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Must match `PROTOCOL_VERSION` in sidecar/src/config.js. A sidecar serving
/// a different value is stale (or foreign) and gets retired and respawned.
const PROTOCOL_VERSION: u32 = 1;
const SIDECAR_PORT: u16 = 7878;
const BASE_URL: &str = "http://127.0.0.1:7878";

fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("sayit")
}

fn data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("sayit")
}

fn read_token() -> String {
    std::fs::read_to_string(config_dir().join("token"))
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

#[tauri::command]
fn get_token() -> String {
    read_token()
}

/// Clipboard text: Wayland first, X11 fallback.
fn read_clipboard() -> Option<String> {
    for (cmd, args) in [
        ("wl-paste", vec!["-n"]),
        ("xclip", vec!["-o", "-selection", "clipboard"]),
        ("xsel", vec!["-b", "-o"]),
    ] {
        if let Ok(out) = Command::new(cmd).args(&args).output() {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !text.is_empty() {
                    return Some(text);
                }
            }
        }
    }
    None
}

async fn speak_text(text: String) -> Result<(), String> {
    let client = reqwest::Client::new();
    client
        .post(format!("{BASE_URL}/v1/speak"))
        .bearer_auth(read_token())
        .json(&serde_json::json!({ "text": text }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn speak_clipboard() {
    if let Some(text) = read_clipboard() {
        tauri::async_runtime::spawn(async move {
            let _ = speak_text(text).await;
        });
    }
}

fn remember_bundled_sidecar(app: &tauri::App) {
    let Ok(index) = app
        .path()
        .resolve("sidecar/src/index.js", BaseDirectory::Resource)
    else {
        return;
    };
    if !index.is_file() {
        return;
    }
    if let Some(dir) = index.parent().and_then(|src| src.parent()) {
        let _ = BUNDLED_SIDECAR_DIR.set(dir.to_path_buf());
    }
}

/// Locate and spawn the sidecar. Search order:
///   1. $SAYIT_SIDECAR_DIR (dev)
///   2. bundled resources (GUI .deb / .rpm)
///   3. ~/.local/share/sayit/sidecar (CLI install.sh)
fn spawn_sidecar() -> Option<Child> {
    let dir = sidecar_dirs()
        .into_iter()
        .find(|p| p.join("src/index.js").is_file())?;

    let node = std::env::var("SAYIT_NODE").unwrap_or_else(|_| "node".to_string());
    let log_path = dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("sayit")
        .join("sidecar.log");
    let _ = std::fs::create_dir_all(log_path.parent().unwrap());
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .ok();
    let (stdout, stderr) = match log {
        Some(file) => {
            let err = file.try_clone().ok();
            (
                Stdio::from(file),
                err.map(Stdio::from).unwrap_or_else(Stdio::null),
            )
        }
        None => (Stdio::null(), Stdio::null()),
    };
    Command::new(node)
        .arg("src/index.js")
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .spawn()
        .ok()
}

#[derive(serde::Deserialize)]
struct SidecarHealth {
    #[serde(default)]
    version: String,
    protocol: u32,
    #[serde(default)]
    pid: Option<u32>,
}

/// GET /v1/health. Ok only on 200 with a parseable body; anything else
/// (nothing on the port, a hung server, wrong token, or a pre-health
/// sidecar answering 404) reads as "no healthy current sidecar".
fn sidecar_health() -> Option<SidecarHealth> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok()?;
    let res = client
        .get(format!("{BASE_URL}/v1/health"))
        .bearer_auth(read_token())
        .send()
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    res.json().ok()
}

fn port_has_listener() -> bool {
    std::net::TcpStream::connect(("127.0.0.1", SIDECAR_PORT)).is_ok()
}

/// Install dirs the app considers its own, in spawn priority order.
fn sidecar_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(dir) = std::env::var("SAYIT_SIDECAR_DIR") {
        dirs.push(PathBuf::from(dir));
    }
    if let Some(dir) = BUNDLED_SIDECAR_DIR.get() {
        dirs.push(dir.clone());
    }
    dirs.push(data_dir().join("sidecar"));
    dirs
}

#[cfg(target_os = "linux")]
fn pid_is_our_sidecar(pid: u32) -> bool {
    if pid == std::process::id() {
        return false;
    }
    let Ok(cwd) = std::fs::canonicalize(format!("/proc/{pid}/cwd")) else {
        return false;
    };
    sidecar_dirs()
        .iter()
        .filter_map(|dir| dir.canonicalize().ok())
        .any(|dir| cwd == dir)
}

#[cfg(target_os = "linux")]
fn pid_alive(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}

#[cfg(target_os = "linux")]
fn read_pidfile() -> Option<u32> {
    std::fs::read_to_string(dirs::cache_dir()?.join("sayit").join("sidecar.pid"))
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Pure-/proc port scan, same approach as cli/sayit.js findListeningPid().
#[cfg(target_os = "linux")]
fn find_listening_pid(port: u16) -> Option<u32> {
    let want = format!("{port:04X}");
    let mut inodes = Vec::new();
    for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(text) = std::fs::read_to_string(table) else { continue };
        for line in text.lines().skip(1) {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 10 {
                continue;
            }
            if cols[1].split(':').next_back() == Some(want.as_str()) && cols[3] == "0A" {
                inodes.push(cols[9].to_string());
            }
        }
    }
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let Some(name) = entry.file_name().to_str().map(String::from) else {
            continue;
        };
        if !name.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            let Ok(target) = std::fs::read_link(fd.path()) else {
                continue;
            };
            if inodes
                .iter()
                .any(|inode| target == PathBuf::from(format!("socket:[{inode}]")))
            {
                return name.parse().ok();
            }
        }
    }
    None
}

/// Terminate a stale sidecar. Attribution rule (mirrored by cli/sayit.js): a
/// pid from a token-verified /v1/health answer is trusted outright; pidfile
/// and port-scan pids are fallbacks, used only while still alive and only
/// after confirming their cwd is one of our sidecar dirs — never touch a
/// process we cannot attribute (upstream PR #21's rule).
#[cfg(target_os = "linux")]
fn retire_stale_sidecar(health_pid: Option<u32>) {
    if let Some(pid) = health_pid {
        if pid != std::process::id() && pid_alive(pid) {
            retire_pid(pid);
            return;
        }
    }
    // Fallbacks, strongest first: the actual port listener, then the pidfile.
    for pid in find_listening_pid(SIDECAR_PORT).into_iter().chain(read_pidfile()) {
        if pid != std::process::id() && pid_alive(pid) && pid_is_our_sidecar(pid) {
            retire_pid(pid);
            return;
        }
    }
}

#[cfg(target_os = "linux")]
fn retire_pid(pid: u32) {
    eprintln!("sayit: retiring stale sidecar pid {pid}");
    unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    for _ in 0..50 {
        if !port_has_listener() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    // A systemd unit with Restart=on-failure keeps the port cycling here;
    // the README troubleshooting says to stop the unit in that case.
    eprintln!("sayit: port {SIDECAR_PORT} still busy 5s after SIGTERM");
}

#[cfg(not(target_os = "linux"))]
fn retire_stale_sidecar(_health_pid: Option<u32>) {}

fn wait_until_healthy(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(h) = sidecar_health() {
            if h.protocol == PROTOCOL_VERSION {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}

/// Archive a freshly spawned sidecar, reaping any child handle we still held
/// so recovery after a hang cannot leave a zombie around until exit.
fn store_sidecar(sidecar: &Arc<Mutex<Option<Child>>>, child: Child) {
    if let Some(mut old) = sidecar.lock().unwrap().take() {
        let _ = old.kill();
        let _ = old.wait();
    }
    *sidecar.lock().unwrap() = Some(child);
}

/// Ensure a healthy current-protocol sidecar answers on the port: retire a
/// stale one, then spawn and poll. Runs once at startup (short wait so the
/// window is never blocked long) and from the watcher (longer wait).
fn recover_sidecar(sidecar: &Arc<Mutex<Option<Child>>>, wait: Duration) -> bool {
    let health = sidecar_health();
    match &health {
        Some(h) if h.protocol == PROTOCOL_VERSION => return true,
        Some(_) => eprintln!(
            "sayit: port {SIDECAR_PORT} serves an outdated protocol (sidecar {})",
            health.as_ref().map(|h| h.version.as_str()).unwrap_or("?")
        ),
        None if port_has_listener() => {
            eprintln!("sayit: port {SIDECAR_PORT} answers but /v1/health fails")
        }
        None => {}
    }
    retire_stale_sidecar(health.and_then(|h| h.pid));
    if !port_has_listener() {
        if let Some(child) = spawn_sidecar() {
            store_sidecar(sidecar, child);
        }
    }
    wait_until_healthy(wait)
}

/// Watch sidecar health; on failure recover, at most twice per disconnected
/// period (upstream PR #21's bound). Any healthy check resets the counter.
fn recovery_watcher(sidecar: Arc<Mutex<Option<Child>>>, shutdown: Arc<AtomicBool>) {
    let mut failures = 0u32;
    while !shutdown.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_secs(30));
        if shutdown.load(Ordering::SeqCst) {
            return;
        }
        match sidecar_health() {
            Some(h) if h.protocol == PROTOCOL_VERSION => failures = 0,
            _ => {
                if failures >= 2 {
                    continue; // gave up for this period; manual fixes reset us via health
                }
                failures += 1;
                eprintln!("sayit: sidecar unhealthy, recovery attempt {failures}/2");
                if recover_sidecar(&sidecar, Duration::from_secs(15)) {
                    failures = 0;
                }
            }
        }
    }
}

fn main() {
    let sidecar = Arc::new(Mutex::new(None::<Child>));
    let shutdown = Arc::new(AtomicBool::new(false));

    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let _ = app; // handler is app-global
                        speak_clipboard();
                    }
                })
                .build(),
        )
        .setup({
            let sidecar = Arc::clone(&sidecar);
            let shutdown = Arc::clone(&shutdown);
            move |app| {
                remember_bundled_sidecar(app);
                // Short wait: the watcher retries with a longer budget, so a slow
                // or unattributable recovery must not delay the window here.
                recover_sidecar(&sidecar, Duration::from_secs(5));
                std::thread::spawn({
                    let sidecar = Arc::clone(&sidecar);
                    let shutdown = Arc::clone(&shutdown);
                    move || recovery_watcher(sidecar, shutdown)
                });

                app.global_shortcut()
                    .register("Ctrl+Alt+V".parse::<tauri_plugin_global_shortcut::Shortcut>()?)?;

                let show = MenuItem::with_id(app, "show", "Show Say It", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &quit])?;

                TrayIconBuilder::new()
                    .menu(&menu)
                    .tooltip("Say It")
                    .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
                        tauri::image::Image::new_owned(vec![0u8; 4], 1, 1)
                    }))
                    .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
                        "show" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .build(app)?;

                Ok(())
            }
        })
        .invoke_handler(tauri::generate_handler![get_token])
        .build(tauri::generate_context!())
        .expect("error while building Say It")
        .run({
            let sidecar = Arc::clone(&sidecar);
            let shutdown = Arc::clone(&shutdown);
            move |_app, event| {
                if let tauri::RunEvent::Exit = event {
                    shutdown.store(true, Ordering::SeqCst);
                    if let Some(mut child) = sidecar.lock().unwrap().take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        });
}
