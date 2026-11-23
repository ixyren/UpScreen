pub mod capture;
pub mod commands;
pub mod encoder;
pub mod frame;
pub mod gpu;
pub mod upscaler;

use commands::{
    cancel_overlay_capture, confirm_overlay_capture, copy_edited_image,
    download_realesrgan_engine, get_editor_capture, get_overlay_session, get_system_status,
    open_editor_window, position_dock_bottom_center, preview_upscale, quit_app, resize_dock,
    save_edited_image, show_or_recreate_dock, show_ready_overlay, start_capture,
    sync_dock_settings, trigger_capture_from_backend, AppState, RegisteredShortcuts,
};
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

fn register_with_fallback(
    app: &tauri::AppHandle,
    mode: &'static str,
    candidates: &[(Modifiers, Code, &'static str)],
) -> String {
    for &(mods, code, label) in candidates {
        let shortcut = Shortcut::new(Some(mods), code);
        let res = app.global_shortcut().on_shortcut(shortcut, move |app_h, _sc, event| {
            if event.state() == ShortcutState::Pressed {
                trigger_capture_from_backend(app_h.clone(), mode);
            }
        });
        if res.is_ok() {
            return label.to_string();
        }
    }
    "No disponible".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let lbl = window.label();
                if lbl == "dock" || lbl == "editor" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            if let Some(dock) = app.get_webview_window("dock") {
                position_dock_bottom_center(&dock, 690.0, 76.0);
                let _ = dock.show();
                let _ = dock.set_focus();
            }

            let show_dock_i =
                MenuItem::with_id(app, "show_dock", "Mostrar Menú Flotante", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let cap_region_i = MenuItem::with_id(
                app,
                "cap_region",
                "Recorte de Pantalla (Ctrl+Shift+S)",
                true,
                None::<&str>,
            )?;
            let cap_window_i = MenuItem::with_id(
                app,
                "cap_window",
                "Capturar Ventana (Ctrl+Shift+W)",
                true,
                None::<&str>,
            )?;
            let cap_full_i = MenuItem::with_id(
                app,
                "cap_full",
                "Pantalla Completa (Ctrl+Shift+F)",
                true,
                None::<&str>,
            )?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let open_editor_i =
                MenuItem::with_id(app, "open_editor", "Abrir Editor", true, None::<&str>)?;
            let quit_i =
                MenuItem::with_id(app, "quit", "Salir de UpScreen", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[
                    &show_dock_i,
                    &sep1,
                    &cap_region_i,
                    &cap_window_i,
                    &cap_full_i,
                    &sep2,
                    &open_editor_i,
                    &quit_i,
                ],
            )?;

            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("UpScreen — Clic izquierdo para mostrar menú · Clic derecho para opciones")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show_dock" => {
                        show_or_recreate_dock(app);
                    }
                    "cap_region" => {
                        trigger_capture_from_backend(app.clone(), "region");
                    }
                    "cap_window" => {
                        trigger_capture_from_backend(app.clone(), "window");
                    }
                    "cap_full" => {
                        trigger_capture_from_backend(app.clone(), "fullscreen");
                    }
                    "open_editor" => {
                        let _ = open_editor_window(app.clone());
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                    | TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } => {
                        show_or_recreate_dock(tray.app_handle());
                    }
                    _ => {}
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }

            let _tray = tray_builder.build(app)?;

            // Register global shortcuts AFTER the Win32 main-thread event loop starts
            let handle = app.handle().clone();
            let cap_reg = cap_region_i.clone();
            let cap_win = cap_window_i.clone();
            let cap_ful = cap_full_i.clone();

            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(250)).await;

                let region_lbl = register_with_fallback(
                    &handle,
                    "region",
                    &[
                        (Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyS, "Ctrl+Shift+S"),
                        (Modifiers::ALT | Modifiers::SHIFT, Code::KeyS, "Alt+Shift+S"),
                        (Modifiers::CONTROL | Modifiers::ALT, Code::KeyS, "Ctrl+Alt+S"),
                    ],
                );
                let window_lbl = register_with_fallback(
                    &handle,
                    "window",
                    &[
                        (Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyW, "Ctrl+Shift+W"),
                        (Modifiers::ALT | Modifiers::SHIFT, Code::KeyW, "Alt+Shift+W"),
                        (Modifiers::CONTROL | Modifiers::ALT, Code::KeyW, "Ctrl+Alt+W"),
                    ],
                );
                let full_lbl = register_with_fallback(
                    &handle,
                    "fullscreen",
                    &[
                        (Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyF, "Ctrl+Shift+F"),
                        (Modifiers::ALT | Modifiers::SHIFT, Code::KeyF, "Alt+Shift+F"),
                        (Modifiers::CONTROL | Modifiers::ALT, Code::KeyF, "Ctrl+Alt+F"),
                    ],
                );

                let shortcuts = RegisteredShortcuts {
                    region: region_lbl.clone(),
                    window: window_lbl.clone(),
                    fullscreen: full_lbl.clone(),
                };

                {
                    let state = handle.state::<AppState>();
                    if let Ok(mut guard) = state.session.lock() {
                        guard.shortcuts = shortcuts.clone();
                    };
                }

                let _ = cap_reg.set_text(format!("Recorte de Pantalla ({region_lbl})"));
                let _ = cap_win.set_text(format!("Capturar Ventana ({window_lbl})"));
                let _ = cap_ful.set_text(format!("Pantalla Completa ({full_lbl})"));
                let _ = handle.emit("shortcuts-updated", shortcuts);
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_system_status,
            start_capture,
            sync_dock_settings,
            quit_app,
            get_overlay_session,
            show_ready_overlay,
            confirm_overlay_capture,
            cancel_overlay_capture,
            get_editor_capture,
            preview_upscale,
            save_edited_image,
            copy_edited_image,
            download_realesrgan_engine,
            open_editor_window,
            resize_dock,
        ])
        .run(tauri::generate_context!())
        .expect("error al ejecutar UpScreen");
}
