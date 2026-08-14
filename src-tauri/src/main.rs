// 桌面端入口：发布构建时隐藏控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    novel_studio_lib::run();
}
