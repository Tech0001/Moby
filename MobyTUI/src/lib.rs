//! One worker owns all state. Both interactive and automated clients use IPC.
pub const PROTOCOL_VERSION: u32 = 9;
pub mod account;
pub mod engine;
pub mod ipc;
pub mod kraken;
pub mod launch;
pub mod model;
pub mod notifications;
pub mod order_sort;
pub mod profile;
pub mod storage;
pub mod tui;
pub mod vault;

pub mod live;
