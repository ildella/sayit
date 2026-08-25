// Say It — Linux port of callebtc/sayit.
// Tauri shell: spawns the pure-JS sidecar, owns the global hotkey and tray,
// and serves the SvelteKit UI.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

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
        .post("http://127.0.0.1:7878/v1/speak")
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

/// Locate and spawn the sidecar. Search order:
///   1. $SAYIT_SIDECAR_DIR (dev)
///   2. ~/.local/share/sayit/sidecar (installed by scripts/setup-sidecar.sh)
fn spawn_sidecar() -> Option<Child> {
    let dir = std::env::var("SAYIT_SIDECAR_DIR")
        .map(PathBuf::from)
        .ok()
        .filter(|p| p.join("src/index.js").exists())
        .or_else(|| {
            let p = data_dir().join("sidecar");
            p.join("src/index.js").exists().then_some(p)
        })?;

    let node = std::env::var("SAYIT_NODE").unwrap_or_else(|_| "node".to_string());
    Command::new(node)
        .arg("src/index.js")
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
}

fn main() {
    let mut sidecar: Option<Child> = None;

    // Only spawn if no service is already answering.
    let already_running = ureq_get_status();
    if !already_running {
        sidecar = spawn_sidecar();
    }

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
        .setup(|app| {
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
        })
        .invoke_handler(tauri::generate_handler![get_token])
        .build(tauri::generate_context!())
        .expect("error while building Say It")
        .run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = sidecar.take() {
                    let _ = child.kill();
                }
            }
        });
}

fn ureq_get_status() -> bool {
    // Cheap health check: is something already listening on 7878?
    std::net::TcpStream::connect("127.0.0.1:7878").is_ok()
}
