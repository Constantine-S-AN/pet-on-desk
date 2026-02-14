use std::fs;
use std::path::{Path, PathBuf};

#[tauri::command]
pub fn find_model3_json(directory: String) -> Result<String, String> {
    let root = PathBuf::from(&directory);
    if !root.exists() {
        return Err("Directory does not exist.".to_string());
    }
    if !root.is_dir() {
        return Err("Selected path is not a directory.".to_string());
    }

    find_first_model3_file(&root)
        .map(|path| path.to_string_lossy().to_string())
        .ok_or_else(|| "No .model3.json file found under selected directory.".to_string())
}

fn find_first_model3_file(root: &Path) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }

            let name = match path.file_name().and_then(|name| name.to_str()) {
                Some(name) => name,
                None => continue,
            };

            if name.ends_with(".model3.json") {
                if let Ok(canonical) = path.canonicalize() {
                    return Some(canonical);
                }
                return Some(path);
            }
        }
    }

    None
}
