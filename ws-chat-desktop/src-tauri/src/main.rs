// Окно к серверу в локальной сети: интерфейс приходит с самого сервера,
// поэтому родные возможности этому окну не выдаются.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

const APP: &str = "ws-chat";

// Пока окно на своей странице, адреса нет и показывать нечего. Как только оно
// ушло на сервер — в заголовке видно, к какому именно и шифруется ли связь:
// иначе подменённый сервер не отличить от своего.
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

fn main() {
    tauri::Builder::default()
        // Проверка адреса идёт через нативную часть: у окна свой origin, и
        // браузерная политика не пустила бы запрос к чужому серверу.
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            // Без сочетаний клавиш: пока фокус в webview, macOS до меню их не
            // доносит, а пункт с подписью, которая не срабатывает, хуже
            // пункта без подписи.
            let switch = MenuItemBuilder::with_id("switch", "Сменить сервер").build(app)?;
            let reload = MenuItemBuilder::with_id("reload", "Обновить страницу").build(app)?;
            let server = SubmenuBuilder::new(app, "Сервер")
                .items(&[&switch, &reload])
                .build()?;
            let menu = Menu::default(app.handle())?;
            menu.append(&server)?;
            app.set_menu(menu)?;

            let handle = app.handle().clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(APP)
                .inner_size(1100.0, 720.0)
                .min_inner_size(420.0, 460.0)
                .on_navigation(move |url| {
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.set_title(&title_for(url));
                    }
                    true
                })
                .build()?;

            // Адрес своей страницы запоминаем сразу: по нему возвращаемся к
            // выбору сервера, не перезапуская приложение.
            let home = window.url()?;

            app.on_menu_event(move |app, event| match event.id().as_ref() {
                "switch" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.navigate(home.clone());
                    }
                }
                "reload" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.eval("location.reload()");
                    }
                }
                _ => {}
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("не удалось запустить приложение");
}
