//! Per-account pacing and short-lived read caches. Never caches credentials or writes.
use super::Inspection;
use anyhow::{Result, ensure};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub(crate) type Shared = Arc<Mutex<Session>>;
pub(crate) struct Session {
    tokens: f64,
    updated: Instant,
    blocked_until: Instant,
    cache: BTreeMap<String, (Instant, Value)>,
    inspection: Option<(Instant, Inspection)>,
}
impl Default for Session {
    fn default() -> Self {
        Self {
            tokens: 15.0,
            updated: Instant::now(),
            blocked_until: Instant::now(),
            cache: BTreeMap::new(),
            inspection: None,
        }
    }
}
impl Session {
    pub fn shared() -> Shared {
        Arc::new(Mutex::new(Self::default()))
    }
    pub fn ready(&self) -> bool {
        Instant::now() >= self.blocked_until
    }
    pub fn block(&mut self, seconds: u64) {
        self.blocked_until = self
            .blocked_until
            .max(Instant::now() + Duration::from_secs(seconds.clamp(1, 86400)));
        self.tokens = 0.0;
    }
    fn delay(&mut self, at: Instant, cost: f64) -> Duration {
        self.tokens = (self.tokens
            + at.saturating_duration_since(self.updated).as_secs_f64() * 0.33)
            .min(15.0);
        self.updated = at;
        if at < self.blocked_until {
            return self.blocked_until - at;
        }
        if self.tokens >= cost {
            self.tokens -= cost;
            Duration::ZERO
        } else {
            Duration::from_secs_f64((cost - self.tokens) / 0.33)
        }
    }
    pub fn get(&self, name: &str, seconds: u64) -> Option<Value> {
        self.cache
            .get(name)
            .filter(|(at, _)| at.elapsed() < Duration::from_secs(seconds))
            .map(|(_, v)| v.clone())
    }
    pub fn put(&mut self, name: &str, value: Value) {
        self.cache.insert(name.into(), (Instant::now(), value));
    }
    pub fn invalidate_orders(&mut self) {
        self.cache.remove("ClosedOrders");
    }
    pub fn invalidate_inspection(&mut self) {
        self.inspection = None;
    }
    pub fn clear_metadata(&mut self) {
        self.cache.clear();
        self.inspection = None;
    }
    pub fn inspection(&self) -> Option<Inspection> {
        self.inspection
            .as_ref()
            .filter(|(at, _)| at.elapsed() < Duration::from_secs(3600))
            .map(|(_, i)| i.clone())
    }
    pub fn inspected(&mut self, inspection: Inspection) {
        self.inspection = Some((Instant::now(), inspection));
    }
}

pub(crate) fn wait(
    session: &Shared,
    path: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<()> {
    // Deliberately conservative across REST and funding. Public metadata costs less.
    let cost = if path.starts_with("/0/public/") {
        0.5
    } else if path.ends_with("TradesHistory") || path.ends_with("QueryLedgers") {
        2.0
    } else {
        1.0
    };
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err(crate::live::transport::Rejected(
                "Request cancelled before dispatch".into(),
            )
            .into());
        }
        ensure!(
            Instant::now() < deadline,
            "Kraken job timed out while waiting for its request budget"
        );
        let delay = session.lock().unwrap().delay(Instant::now(), cost);
        if delay.is_zero() {
            return Ok(());
        }
        std::thread::sleep(delay.min(Duration::from_millis(100)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pacing_and_cooldown_apply_across_requests() {
        let mut s = Session::default();
        let at = Instant::now();
        for _ in 0..7 {
            assert!(s.delay(at, 2.0).is_zero());
        }
        assert!(s.delay(at, 2.0) >= Duration::from_secs(3));
        assert!(s.delay(at + Duration::from_secs(4), 2.0).is_zero());
        s.block(120);
        assert!(!s.ready());
        assert!(s.delay(Instant::now(), 1.0) > Duration::from_secs(119));
    }
    #[test]
    fn cancelled_wait_never_dispatches() {
        let s = Session::shared();
        s.lock().unwrap().block(120);
        assert!(
            wait(
                &s,
                "/0/private/AddOrder",
                &AtomicBool::new(true),
                Instant::now() + Duration::from_secs(1)
            )
            .unwrap_err()
            .is::<crate::live::transport::Rejected>()
        );
    }
}
