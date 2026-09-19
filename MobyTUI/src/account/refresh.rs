//! Read-only refresh deadlines, independent of withdrawal rules and pause state.
use crate::model::RefreshStatus;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Resource {
    Balances,
    Orders,
    Wallets,
    Key,
}
impl Resource {
    pub fn interval(self) -> i64 {
        match self {
            Self::Wallets => 300,
            _ => 30,
        }
    }
}

#[derive(Default)]
struct Slot {
    due: i64,
    requested: bool,
    refreshing: bool,
    checked_this_session: bool,
    failures: u32,
}

#[derive(Default)]
pub(super) struct Refresh {
    slots: [Slot; 4],
}
impl Refresh {
    pub fn request(&mut self, resource: Resource) {
        let slot = &mut self.slots[resource as usize];
        if !slot.refreshing {
            slot.requested = true;
            slot.due = 0;
        }
    }
    pub fn next(&self, at: i64) -> Option<Resource> {
        [
            Resource::Balances,
            Resource::Orders,
            Resource::Wallets,
            Resource::Key,
        ]
        .into_iter()
        .filter(|r| {
            let s = &self.slots[*r as usize];
            !s.refreshing && s.due <= at && (*r != Resource::Key || s.requested)
        })
        .min_by_key(|r| {
            let s = &self.slots[*r as usize];
            (!s.requested, s.due)
        })
    }
    pub fn started(&mut self, resource: Resource) {
        let slot = &mut self.slots[resource as usize];
        slot.refreshing = true;
        slot.requested = false;
    }
    pub fn cancelled(&mut self, resource: Resource) {
        let slot = &mut self.slots[resource as usize];
        slot.refreshing = false;
        slot.due = 0;
    }
    pub fn finished(&mut self, resource: Resource, at: i64, success: bool) {
        let slot = &mut self.slots[resource as usize];
        slot.refreshing = false;
        slot.requested = false;
        slot.checked_this_session = success;
        if success {
            slot.failures = 0;
            slot.due = at + resource.interval();
        } else {
            slot.failures = slot.failures.saturating_add(1);
            slot.due = at + (15 * (1i64 << slot.failures.saturating_sub(1).min(6))).min(300);
        }
    }
    pub fn status(
        &self,
        resource: Resource,
        updated_at: Option<i64>,
        error: Option<&str>,
        enabled: bool,
        at: i64,
    ) -> RefreshStatus {
        let slot = &self.slots[resource as usize];
        RefreshStatus {
            enabled,
            stale: !enabled
                || !slot.checked_this_session
                || error.is_some()
                || updated_at
                    .is_none_or(|t| t > at || at.saturating_sub(t) > resource.interval() * 2),
            refreshing: enabled && (slot.refreshing || slot.requested),
            interval_seconds: resource.interval() as u64,
            next_refresh_at: (enabled && !slot.refreshing).then_some(slot.due.max(at)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refresh_retries_back_off_without_starving_other_resources_or_claiming_freshness() {
        let mut refresh = Refresh::default();
        assert_eq!(refresh.next(100), Some(Resource::Balances));
        refresh.started(Resource::Balances);
        assert_eq!(refresh.next(100), Some(Resource::Orders));
        refresh.finished(Resource::Balances, 100, false);
        assert_eq!(
            refresh
                .status(Resource::Balances, Some(99), None, true, 100)
                .next_refresh_at,
            Some(115)
        );
        assert!(
            refresh
                .status(Resource::Balances, Some(99), None, true, 100)
                .stale
        );
        refresh.finished(Resource::Orders, 100, true);
        refresh.finished(Resource::Wallets, 100, true);
        assert_eq!(refresh.next(114), None);
        assert_eq!(refresh.next(115), Some(Resource::Balances));
        for at in 115..130 {
            refresh.finished(Resource::Balances, at, false);
        }
        assert_eq!(
            refresh
                .status(Resource::Balances, Some(99), None, true, 129)
                .next_refresh_at,
            Some(429)
        );
        refresh.finished(Resource::Balances, 430, true);
        assert!(
            !refresh
                .status(Resource::Balances, Some(430), None, true, 430)
                .stale
        );
        assert!(
            refresh
                .status(Resource::Balances, Some(430), None, true, 491)
                .stale
        );
        assert!(
            refresh
                .status(Resource::Balances, Some(430), None, false, 430)
                .stale
        );
        assert!(
            refresh
                .status(Resource::Balances, Some(430), Some("offline"), true, 430)
                .stale
        );
    }
}
