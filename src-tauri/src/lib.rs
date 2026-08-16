//! Novel Studio 后端入口

mod commands;
mod commands_publish;
mod commands_style;
mod commands_video;
mod db;
mod image_gen;
mod llm;
mod tasks;
mod video;
mod video_gen;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 数据库放在系统应用数据目录（Windows: %APPDATA%/com.novelstudio.app）
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db = db::Db::new(&dir.join("novel-studio.db"))?;
            tasks::spawn_worker(app.handle().clone(), db.clone()); // 任务队列 worker（长任务串行执行）
            app.manage(db);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_project,
            commands::update_project_targets,
            commands::list_projects,
            commands::rename_project,
            commands::delete_project,
            commands::save_project_info,
            commands::generate_synopsis,
            commands::list_outline,
            commands::add_outline_item,
            commands::save_outline_item,
            commands::set_outline_status,
            commands::delete_outline_item,
            commands::generate_outline,
            commands::set_lore_ref_image,
            commands::remove_lore_ref_image,
            commands::create_chapter,
            commands::list_chapters,
            commands::get_chapter,
            commands::save_chapter,
            commands::delete_chapter,
            commands::get_setting,
            commands::set_setting,
            commands::create_lore_entry,
            commands::list_lore_entries,
            commands::update_lore_entry,
            commands::delete_lore_entry,
            commands::save_summary,
            commands::export_project,
            commands::generate_cover,
            commands::list_covers,
            commands::get_cover_data,
            commands::summary_stats,
            commands::generate_missing_summaries,
            tasks::enqueue_batch_chapters,
            tasks::enqueue_video_shots,
            tasks::enqueue_rewrite_chapters,
            tasks::list_tasks,
            tasks::cancel_task,
            tasks::resume_task,
            tasks::retry_task,
            tasks::clear_finished_tasks,
            commands::locate_rewrite_scope,
            commands::rollback_rewrite_task,
            commands::scan_banned_words,
            commands::check_consistency,
            commands::save_check_report,
            commands::list_check_reports,
            commands::get_check_report,
            commands::ai_continue,
            commands::ai_transform,
            commands::generate_summary,
            commands::ai_bootstrap_draft,
            commands::ai_bootstrap_chat,
            commands::ai_bootstrap_chat_stream,
            commands::save_chat_session,
            commands::get_latest_chat_session,
            commands::list_chat_sessions,
            commands::delete_chat_session,
            commands::assistant_chat,
            commands::assistant_rewrite_chapter,
            commands::ai_polish_idea,
            commands_style::distill_style,
            commands_style::list_styles,
            commands_style::delete_style,
            commands_style::set_project_style,
            commands_style::generate_style_card,
            commands_style::save_style_card,
            commands_publish::open_fanqie_window,
            commands_publish::fill_chapter_draft,
            commands_publish::open_douyin_window,
            commands_publish::fill_douyin_caption,
            commands_video::create_video,
            commands_video::list_videos,
            commands_video::get_video_detail,
            commands_video::delete_video,
            commands_video::save_narration,
            commands_video::update_shot_prompt,
            commands_video::generate_narration,
            commands_video::generate_storyboard,
            commands_video::generate_shot_image,
            commands_video::generate_shot_video,
            commands_video::set_video_extras,
            commands_video::generate_missing_images,
            commands_video::synthesize_voices,
            commands_video::compose_video,
            commands_video::open_video_folder,
        ])
        .run(tauri::generate_context!())
        .expect("运行 Tauri 应用失败");
}
