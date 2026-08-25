// Окно к серверу в локальной сети: интерфейс приходит с самого сервера,
// поэтому родные возможности этому окну не выдаются.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        // Проверка адреса идёт через нативную часть: у окна свой origin, и
        // браузерная политика не пустила бы запрос к чужому серверу.
        .plugin(tauri_plugin_http::init())
        .run(tauri::generate_context!())
        .expect("не удалось запустить приложение");
}
