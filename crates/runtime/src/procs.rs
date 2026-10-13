//! Finding a profile's browser in the process table.
//!
//! Chromium's browser (main) process is the one started with `--user-data-dir=<this profile>` and without a
//! `--type=` switch; renderers, GPU, network and other helpers carry `--type=...` and descend from it. The manager
//! uses this to:
//!  - re-attach to a browser left running when the manager crashed or quit (only if the executable is the runtime
//!    the manager launched and the start time matches the recorded run, or no run was recorded and the executable
//!    matches);
//!  - refuse to start a second browser on a directory that is in use;
//!  - tell a "ready" runtime (main process holds Chromium's profile lock and helpers are up) from an open window
//!    (at least one renderer);
//!  - force-close a whole tree, never anything outside it.

use crate::inspect::ProcRecord;
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::Path;

pub fn user_data_flag(user_data: &Path) -> OsString {
    let mut s = OsString::from("--user-data-dir=");
    s.push(user_data.as_os_str());
    s
}

fn is_main_for(p: &ProcRecord, flag: &str) -> bool {
    p.args.iter().any(|a| a == flag) && !p.args.iter().any(|a| a.starts_with("--type="))
}

/// Browser main processes whose command line names exactly this user-data directory.
pub fn browser_mains<'a>(snapshot: &'a [ProcRecord], user_data: &Path) -> Vec<&'a ProcRecord> {
    let flag = user_data_flag(user_data).to_string_lossy().into_owned();
    snapshot.iter().filter(|p| is_main_for(p, &flag)).collect()
}

/// All descendants of `pid` (children, grandchildren, ...), excluding `pid` itself.
pub fn descendants(snapshot: &[ProcRecord], pid: u32) -> Vec<&ProcRecord> {
    let mut children: HashMap<u32, Vec<&ProcRecord>> = HashMap::new();
    for p in snapshot {
        if let Some(parent) = p.parent
            && parent != p.pid
        {
            children.entry(parent).or_default().push(p);
        }
    }
    let mut out = vec![];
    let mut seen = HashSet::from([pid]);
    let mut queue = vec![pid];
    while let Some(next) = queue.pop() {
        for c in children.get(&next).map(Vec::as_slice).unwrap_or(&[]) {
            if seen.insert(c.pid) {
                out.push(*c);
                queue.push(c.pid);
            }
        }
    }
    out
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TreeFacts {
    pub helpers: usize,
    pub renderers: usize,
}

pub fn tree_facts(snapshot: &[ProcRecord], main_pid: u32) -> TreeFacts {
    let d = descendants(snapshot, main_pid);
    TreeFacts {
        helpers: d.len(),
        renderers: d
            .iter()
            .filter(|p| p.args.iter().any(|a| a == "--type=renderer"))
            .count(),
    }
}

/// Process count and resident memory of a browser tree (main process and all its descendants).
pub fn tree_memory(snapshot: &[ProcRecord], main_pid: u32) -> (usize, u64) {
    let main = snapshot
        .iter()
        .find(|p| p.pid == main_pid)
        .map_or(0, |p| p.memory_bytes);
    let d = descendants(snapshot, main_pid);
    (
        d.len() + 1,
        main + d.iter().map(|p| p.memory_bytes).sum::<u64>(),
    )
}

/// Chromium's own profile lock: `SingletonLock` (macOS/Linux, a symlink) or `lockfile` (Windows).
pub fn singleton_present(user_data: &Path) -> bool {
    ["SingletonLock", "lockfile"]
        .iter()
        .any(|n| std::fs::symlink_metadata(user_data.join(n)).is_ok())
}

/// True if `exe` is the same file as `expected` (canonical paths; falls back to exact comparison).
pub fn same_executable(exe: Option<&Path>, expected: &Path) -> bool {
    let Some(exe) = exe else {
        return false;
    };
    match (exe.canonicalize(), expected.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => exe == expected,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn rec(pid: u32, parent: Option<u32>, args: &[&str]) -> ProcRecord {
        ProcRecord {
            pid,
            parent,
            start_time: 100,
            exe: Some(PathBuf::from("/rt/chrome")),
            args: args.iter().map(|s| s.to_string()).collect(),
            memory_bytes: 1_000_000,
        }
    }

    #[test]
    fn finds_main_process_and_its_tree_only() {
        let a = Path::new("/data/profiles/prf_A/user-data");
        let flag_a = user_data_flag(a).to_string_lossy().into_owned();
        let flag_b = "--user-data-dir=/data/profiles/prf_B/user-data";
        let snap = vec![
            rec(10, Some(1), &["chrome", &flag_a, "--no-first-run"]),
            rec(11, Some(10), &["chrome", "--type=zygote", &flag_a]),
            rec(12, Some(11), &["chrome", "--type=renderer"]),
            rec(13, Some(10), &["chrome", "--type=gpu-process", &flag_a]),
            rec(20, Some(1), &["chrome", flag_b]),
            rec(21, Some(20), &["chrome", "--type=renderer"]),
            rec(30, Some(1), &["chrome", &format!("{flag_a}-other")]),
        ];
        let mains = browser_mains(&snap, a);
        assert_eq!(mains.iter().map(|p| p.pid).collect::<Vec<_>>(), vec![10]);
        let mut tree: Vec<u32> = descendants(&snap, 10).iter().map(|p| p.pid).collect();
        tree.sort();
        assert_eq!(
            tree,
            vec![11, 12, 13],
            "never includes profile B's processes"
        );
        assert_eq!(
            tree_facts(&snap, 10),
            TreeFacts {
                helpers: 3,
                renderers: 1
            }
        );
    }

    #[test]
    fn tolerates_cycles_and_self_parents() {
        let snap = vec![
            rec(1, Some(1), &[]),
            rec(2, Some(3), &[]),
            rec(3, Some(2), &[]),
        ];
        assert!(descendants(&snap, 1).is_empty());
        assert_eq!(descendants(&snap, 2).len(), 1);
    }
}
