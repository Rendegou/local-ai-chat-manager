//! Single catalog for native readers, import-only sources and recognised-but-unadapted tools.
//!
//! `access` 的三种取值决定一个来源在界面上能被怎么用：
//!
//! | access    | 含义 | `native_adapters()` | 出现在「添加来源」 | 可配置 |
//! | --------- | ---- | ------------------- | ------------------ | ------ |
//! | `native`  | 有内置适配器 | 有 | 未连接时 | 目录 |
//! | `import`  | 只支持手动导入标准包 | 无 | 是 | 无 |
//! | `pending` | 认识这个工具、知道数据大概在哪，但**还没写适配器** | 无 | 是（标「待适配」） | 无 |
//!
//! `pending` 的用处是把「产品不支持」变成「还没做」：用户能看见我们认识这个工具，
//! 而不是在列表里找不到、以为永远不会有。它也是收集真实需求的地方——
//! 哪个 pending 条目被问得最多，下一个适配器就写哪个。
//!
//! 注意 `pending` 条目的 `description` 里的路径是**常见位置且未在本机验证**的：
//! 我们刻意不写成一个看起来权威的默认路径，因为一旦写错，用户会照着去指一个空目录。
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
        // 已识别但尚未适配：列在这里比让用户找不到更有用。
        // 真的想把它们接进来时，用「自定义来源」填一份字段映射即可，不必等我们写适配器。
        definition("cline", "Cline", "pending", "尚未适配。常见位置：VS Code globalStorage 的 saoudrizwan.claude-dev/tasks（未在本机验证）", &[]),
        definition("continue", "Continue.dev", "pending", "尚未适配。常见位置：~/.continue/sessions（未在本机验证）", &[]),
        definition("aider", "Aider", "pending", "尚未适配。常见位置：项目目录下的 .aider.chat.history.md（未在本机验证）", &[]),
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
