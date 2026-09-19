//! Single catalog for native readers and import-only sources.
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDefinition {
    pub id: &'static str,
    pub display_name: &'static str,
    pub adapter_version: u32,
    pub access: &'static str,
    pub platforms: &'static [&'static str],
    pub description: &'static str,
    pub watch_extensions: &'static [&'static str],
}

pub fn catalog() -> &'static [SourceDefinition] {
    const CATALOG: &[SourceDefinition] = &[
        definition("codex", "Codex", "native", "Codex 数据目录，留空自动发现", &["json", "jsonl"]),
        definition("kimi", "Kimi Code", "native", "Kimi Code 数据目录，留空自动发现", &["json", "jsonl"]),
        definition("cursor", "Cursor", "native", "globalStorage 目录（state.vscdb）", &["vscdb", "vscdb-wal"]),
        definition("zcode", "ZCode", "native", "ZCode v2/sessions 目录", &["json", "jsonl"]),
        definition("claude", "Claude Code", "native", "~/.claude/projects 项目历史目录", &["jsonl"]),
        definition("gemini", "Gemini CLI", "native", "~/.gemini/tmp 项目历史目录", &["json"]),
        SourceDefinition { platforms: &["windows"], ..definition("workbuddy", "WorkBuddy", "native", "WorkBuddy 应用数据目录；按检测结果显示正文支持程度", &["json", "jsonl", "vscdb", "vscdb-wal"]) },
        definition("doubao-work", "豆包工作", "import", "仅支持标准格式手动导入；自动采集待适配", &[]),
    ];
    CATALOG
}

const fn definition(id: &'static str, display_name: &'static str, access: &'static str, description: &'static str, watch_extensions: &'static [&'static str]) -> SourceDefinition {
    SourceDefinition { id, display_name, adapter_version: 1, access, platforms: &["windows", "macos", "linux"], description, watch_extensions }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCatalogEntry {
    #[serde(flatten)] pub definition: SourceDefinition,
    pub status: String,
    pub enabled: bool,
    pub notes: Option<String>,
}

pub fn native_adapters() -> Vec<Box<dyn super::ConversationAdapter>> {
    use super::*;
    catalog().iter().filter_map(|source| {
        let adapter: Box<dyn ConversationAdapter> = match source.id {
            "codex" => Box::new(CodexAdapter::new()),
            "kimi" => Box::new(KimiAdapter::new()),
            "cursor" => Box::new(CursorAdapter::new()),
            "zcode" => Box::new(ZcodeAdapter::new()),
            "claude" => Box::new(native::NativeAdapter { source: SourceKind::Claude }),
            "gemini" => Box::new(native::NativeAdapter { source: SourceKind::Gemini }),
            "workbuddy" => Box::new(workbuddy::WorkbuddyAdapter),
            _ => return None,
        };
        Some(adapter)
    }).collect()
}
