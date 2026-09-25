//! Each feature runs a small, fixed workload shaped like Fiber's use of that
//! crate. With no features the program does nothing, and that is the baseline.
#![allow(unused)]
use std::hint::black_box;

fn text(lines: usize) -> String {
    (0..lines).map(|i| format!("line {i}: the quick brown fox_{i} jumps over 42 lazy dogs\n")).collect()
}

fn main() {
    #[cfg(feature = "serde_json")]
    {
        #[derive(serde::Serialize, serde::Deserialize)]
        struct Event { kind: String, session_id: String, ts: u64, text: String }
        let events: Vec<Event> = (0..100)
            .map(|i| Event { kind: "assistant_delta".into(), session_id: "s1".into(), ts: i, text: "x".repeat(100) })
            .collect();
        let lines: Vec<String> = events.iter().map(|e| serde_json::to_string(e).unwrap()).collect();
        let back: Vec<Event> = lines.iter().map(|l| serde_json::from_str(l).unwrap()).collect();
        black_box(back);
    }
    #[cfg(feature = "ureq")]
    {
        // One real HTTPS request: loads the OS trust store and runs a handshake.
        let body = ureq::get("https://example.com").call().unwrap().into_body().read_to_string().unwrap();
        black_box(body);
    }
    #[cfg(feature = "ratatui")]
    {
        use ratatui::{Terminal, backend::TestBackend, widgets::Paragraph};
        let mut t = Terminal::new(TestBackend::new(200, 50)).unwrap();
        let s = text(60);
        for _ in 0..10 {
            t.draw(|f| f.render_widget(Paragraph::new(s.as_str()), f.area())).unwrap();
        }
    }
    #[cfg(feature = "rusqlite")]
    {
        let path = std::env::temp_dir().join(format!("dep-rss-{}.db", std::process::id()));
        let mut db = rusqlite::Connection::open(&path).unwrap();
        db.pragma_update(None, "journal_mode", "WAL").unwrap();
        db.execute("create table s (id integer primary key, title text, ts integer)", []).unwrap();
        let tx = db.transaction().unwrap();
        for i in 0..100 {
            tx.execute("insert into s (title, ts) values (?1, ?2)", (format!("session {i}"), i)).unwrap();
        }
        tx.commit().unwrap();
        let n: i64 = db.query_row("select count(*) from s where title like '%9%'", [], |r| r.get(0)).unwrap();
        black_box(n);
        drop(db);
        for ext in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{ext}", path.display()));
        }
    }
    #[cfg(feature = "mlua")]
    {
        let lua = mlua::Lua::new();
        let n: i64 = lua
            .load("local t = {} for i = 1, 100 do t[i] = { name = 'tool' .. i } end return #t")
            .eval()
            .unwrap();
        black_box(n);
    }
    #[cfg(feature = "clap")]
    {
        #[derive(clap::Parser)]
        struct Cli { #[command(subcommand)] cmd: Option<Cmd> }
        #[derive(clap::Subcommand)]
        enum Cmd {
            Ask { prompt: String }, Continue, Sessions,
            Session { #[command(subcommand)] cmd: SessionCmd },
            Auth, Models, Usage, Status, Doctor, Config { key: Option<String> }, Mcp, Permissions,
            Workspace, Upgrade, Serve, Remote, Install { name: String }, Update, List, Remove { name: String }, Approve,
        }
        #[derive(clap::Subcommand)]
        enum SessionCmd { Show { id: String }, List, Rename { id: String, title: String }, Remove { id: String }, Resume, Recover { id: String } }
        let cli = <Cli as clap::Parser>::parse_from(["fiber", "session", "rename", "abc", "new title"]);
        black_box(cli.cmd.is_some());
    }
    #[cfg(feature = "thiserror")]
    {
        #[derive(Debug, thiserror::Error)]
        enum E { #[error("provider {0} returned {1}")] Provider(String, u16) }
        black_box(E::Provider("openrouter".into(), 429).to_string());
    }
    #[cfg(feature = "signal-hook")]
    {
        let mut s = signal_hook::iterator::Signals::new([signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT]).unwrap();
        black_box(s.pending().count());
    }
    #[cfg(feature = "getrandom")]
    {
        let mut b = [0u8; 16];
        getrandom::fill(&mut b).unwrap();
        black_box(b);
    }
    #[cfg(feature = "base64")]
    {
        use base64::Engine;
        black_box(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(vec![7u8; 4096]));
    }
    #[cfg(feature = "ring")]
    {
        black_box(ring::digest::digest(&ring::digest::SHA256, &vec![7u8; 4096]));
    }
    #[cfg(feature = "rustix")]
    {
        let fd = rustix::pty::openpt(rustix::pty::OpenptFlags::RDWR | rustix::pty::OpenptFlags::NOCTTY).unwrap();
        rustix::pty::grantpt(&fd).unwrap();
        rustix::pty::unlockpt(&fd).unwrap();
        black_box(rustix::pty::ptsname(&fd, Vec::new()).unwrap());
    }
    #[cfg(feature = "regex")]
    {
        let re = regex::Regex::new(r"\w+_\d{2,}\s+jumps").unwrap();
        black_box(re.find_iter(&text(200)).count());
    }
    #[cfg(feature = "ignore")]
    {
        // The probe's own directory, including target/, is the tree walked.
        let n = ignore::WalkBuilder::new(env!("CARGO_MANIFEST_DIR")).build().filter_map(Result::ok).count();
        black_box(n);
    }
    #[cfg(feature = "similar")]
    {
        let a = text(200);
        let b = a.replace("fox_5", "cat_5");
        black_box(similar::TextDiff::from_lines(&a, &b).unified_diff().to_string());
    }
    #[cfg(feature = "pulldown-cmark")]
    {
        let md = "# Heading\n\nSome *emphasis* and `code`.\n\n- item\n- item\n\n```rust\nfn main() {}\n```\n\n".repeat(20);
        black_box(pulldown_cmark::Parser::new(&md).count());
    }
    #[cfg(feature = "syntect")]
    {
        use syntect::{easy::HighlightLines, highlighting::ThemeSet, parsing::SyntaxSet};
        let ss = SyntaxSet::load_defaults_newlines();
        let ts = ThemeSet::load_defaults();
        let mut h = HighlightLines::new(ss.find_syntax_by_extension("rs").unwrap(), &ts.themes["base16-ocean.dark"]);
        for l in text(100).lines() {
            black_box(h.highlight_line(l, &ss).unwrap());
        }
    }
}
