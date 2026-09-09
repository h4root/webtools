#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Mutex, OnceLock};

use tauri::utils::config::WindowEffectsConfig;
use tauri::utils::WindowEffect;
use tauri::webview::WebviewBuilder;
use tauri::window::WindowBuilder;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewUrl, WindowEvent,
};
use url::Url;

const APP: &str = "ws-chat";

/// Высота своей полосы заголовка. Окно без декораций, поэтому рисуем её сами.
const BAR: f64 = 34.0;

/// Адрес страницы выбора сервера. Узнаём его из первой навигации: сразу после
/// build() вебвью ещё стоит на about:blank.
struct Home(OnceLock<Url>);

/// Последнее, что показывала полоса: заголовок и «мы на своей странице».
/// Полоса грузится параллельно с содержимым и может пропустить первое событие.
struct Shown(Mutex<(String, bool)>);

fn title_for(url: &Url) -> String {
    match url.scheme() {
        "https" => format!("{APP} — {} · зашифровано", host_of(url)),
        "http" => format!("{APP} — {} · без шифрования", host_of(url)),
        _ => APP.to_string(),
    }
}

fn host_of(url: &Url) -> String {
    match (url.host_str(), url.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_string(),
        _ => String::new(),
    }
}

/// Полоса сверху во всю ширину, содержимое под ней.
fn layout(app: &AppHandle) {
    let (Some(window), Some(chrome), Some(content)) = (
        app.get_window("main"),
        app.get_webview("chrome"),
        app.get_webview("content"),
    ) else {
        return;
    };
    let (Ok(scale), Ok(size)) = (window.scale_factor(), window.inner_size()) else {
        return;
    };
    let size = size.to_logical::<f64>(scale);

    let _ = chrome.set_position(LogicalPosition::new(0.0, 0.0));
    let _ = chrome.set_size(LogicalSize::new(size.width, BAR));
    let _ = content.set_position(LogicalPosition::new(0.0, BAR));
    let _ = content.set_size(LogicalSize::new(size.width, (size.height - BAR).max(0.0)));
}

fn tell_maximized(app: &AppHandle) {
    let Some(window) = app.get_window("main") else {
        return;
    };
    let _ = app.emit_to("chrome", "chrome:maximized", window.is_maximized().unwrap_or(false));
}

#[tauri::command]
fn chrome_ready(app: AppHandle, shown: State<'_, Shown>) {
    let (title, own) = shown.0.lock().map(|it| it.clone()).unwrap_or_default();
    let _ = app.emit_to("chrome", "chrome:title", title);
    let _ = app.emit_to("chrome", "chrome:home", own);
    tell_maximized(&app);
}

#[tauri::command]
fn go_back(app: AppHandle) {
    if let Some(content) = app.get_webview("content") {
        let _ = content.eval("history.back()");
    }
}

#[tauri::command]
fn go_home(app: AppHandle, home: State<'_, Home>) {
    let (Some(content), Some(url)) = (app.get_webview("content"), home.0.get()) else {
        return;
    };
    let _ = content.navigate(url.clone());
}

#[tauri::command]
fn win_minimize(app: AppHandle) {
    if let Some(window) = app.get_window("main") {
        let _ = window.minimize();
    }
}

#[tauri::command]
fn win_toggle_maximize(app: AppHandle) {
    let Some(window) = app.get_window("main") else {
        return;
    };
    let _ = if window.is_maximized().unwrap_or(false) {
        window.unmaximize()
    } else {
        window.maximize()
    };
}

#[tauri::command]
fn win_close(app: AppHandle) {
    if let Some(window) = app.get_window("main") {
        let _ = window.close();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            chrome_ready,
            go_back,
            go_home,
            win_minimize,
            win_toggle_maximize,
            win_close
        ])
        .setup(|app| {
            app.manage(Home(OnceLock::new()));
            app.manage(Shown(Mutex::new((APP.to_string(), true))));

            let window = WindowBuilder::new(app, "main")
                .title(APP)
                .inner_size(1100.0, 720.0)
                .min_inner_size(420.0, 460.0)
                .decorations(false)
                .transparent(true)
                .effects(WindowEffectsConfig {
                    effects: vec![WindowEffect::Mica],
                    state: None,
                    radius: None,
                    color: None,
                })
                .build()?;

            let scale = window.scale_factor()?;
            let size = window.inner_size()?.to_logical::<f64>(scale);

            window.add_child(
                WebviewBuilder::new("chrome", WebviewUrl::App("chrome.html".into())).transparent(true),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(size.width, BAR),
            )?;

            let handle = app.handle().clone();
            window.add_child(
                WebviewBuilder::new("content", WebviewUrl::App("index.html".into())).on_navigation(
                    move |url| {
                        let home = handle.state::<Home>();
                        home.0.get_or_init(|| url.clone());
                        let own = home.0.get().is_some_and(|it| it.origin() == url.origin());
                        let title = if own { APP.to_string() } else { title_for(url) };

                        if let Some(window) = handle.get_window("main") {
                            let _ = window.set_title(&title);
                        }
                        if let Ok(mut shown) = handle.state::<Shown>().0.lock() {
                            *shown = (title.clone(), own);
                        }
                        let _ = handle.emit_to("chrome", "chrome:title", title);
                        let _ = handle.emit_to("chrome", "chrome:home", own);
                        true
                    },
                ),
                LogicalPosition::new(0.0, BAR),
                LogicalSize::new(size.width, (size.height - BAR).max(0.0)),
            )?;

            let handle = app.handle().clone();
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::Resized(_)) {
                    layout(&handle);
                    tell_maximized(&handle);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("не удалось запустить приложение");
}
