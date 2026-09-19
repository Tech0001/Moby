use crate::{live::model::Order, model::amount};
use clap::ValueEnum;
use std::cmp::Ordering;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum OrderSort {
    #[default]
    Status,
    Pair,
    Side,
    Type,
    Price,
    Size,
    Filled,
}

impl OrderSort {
    pub fn next(self) -> Self {
        match self {
            Self::Status => Self::Pair,
            Self::Pair => Self::Side,
            Self::Side => Self::Type,
            Self::Type => Self::Price,
            Self::Price => Self::Size,
            Self::Size => Self::Filled,
            Self::Filled => Self::Status,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Status => "State",
            Self::Pair => "Pair",
            Self::Side => "Side",
            Self::Type => "Type",
            Self::Price => "Price",
            Self::Size => "Size",
            Self::Filled => "Filled",
        }
    }

    pub fn sorted(self, orders: &[Order], descending: bool) -> Vec<&Order> {
        let mut rows: Vec<_> = orders.iter().collect();
        rows.sort_by(|a, b| {
            let order = match self {
                Self::Status => status_rank(&a.status)
                    .cmp(&status_rank(&b.status))
                    .then_with(|| a.status.cmp(&b.status)),
                Self::Pair => a.pair.cmp(&b.pair),
                Self::Side => a.side.cmp(&b.side),
                Self::Type => a.order_type.cmp(&b.order_type),
                Self::Price => {
                    return numeric(&a.price, &b.price, descending).then_with(|| tie(a, b));
                }
                Self::Size => {
                    return numeric(&a.volume, &b.volume, descending).then_with(|| tie(a, b));
                }
                Self::Filled => {
                    return numeric(&a.filled, &b.filled, descending).then_with(|| tie(a, b));
                }
            };
            (if descending { order.reverse() } else { order }).then_with(|| tie(a, b))
        });
        rows
    }
}

fn tie(a: &Order, b: &Order) -> Ordering {
    a.pair.cmp(&b.pair).then_with(|| a.id.cmp(&b.id))
}

fn numeric(a: &str, b: &str, descending: bool) -> Ordering {
    match (amount(a), amount(b)) {
        (Ok(a), Ok(b)) => {
            if descending {
                b.cmp(&a)
            } else {
                a.cmp(&b)
            }
        }
        // Unavailable values stay last in either direction.
        (Ok(_), Err(_)) => Ordering::Less,
        (Err(_), Ok(_)) => Ordering::Greater,
        (Err(_), Err(_)) => Ordering::Equal,
    }
}

fn status_rank(status: &str) -> u8 {
    match status {
        "pending" | "open" => 0,
        "closed" => 1,
        "canceled" | "cancelled" => 2,
        "expired" => 3,
        _ => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn order(id: &str, price: &str, status: &str) -> Order {
        Order {
            id: id.into(),
            pair: "BTC/USD".into(),
            side: "buy".into(),
            order_type: "limit".into(),
            volume: price.into(),
            filled: price.into(),
            price: price.into(),
            status: status.into(),
            client_id: None,
        }
    }

    #[test]
    fn decimals_sort_exactly_with_stable_ties_and_missing_values_last() {
        let orders = vec![
            order("large", "10", "open"),
            order("small", "2", "open"),
            order("tiny", "0.000000000000000001", "open"),
            order("near", "2.000000000000000001", "open"),
            order("equal", "2.0", "open"),
            order("missing", "", "open"),
        ];
        for sort in [OrderSort::Price, OrderSort::Size, OrderSort::Filled] {
            let ids = |descending| {
                sort.sorted(&orders, descending)
                    .iter()
                    .map(|o| o.id.as_str())
                    .collect::<Vec<_>>()
            };
            assert_eq!(
                ids(false),
                ["tiny", "equal", "small", "near", "large", "missing"]
            );
            assert_eq!(
                ids(true),
                ["large", "near", "equal", "small", "tiny", "missing"]
            );
        }
    }

    #[test]
    fn default_lists_active_orders_first_independent_of_source_order() {
        let mut orders = vec![
            order("done", "1", "closed"),
            order("active", "1", "open"),
            order("cancel", "1", "canceled"),
        ];
        let ids = |orders: &[Order]| {
            OrderSort::default()
                .sorted(orders, false)
                .iter()
                .map(|o| o.id.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&orders), ["active", "done", "cancel"]);
        orders.reverse();
        assert_eq!(ids(&orders), ["active", "done", "cancel"]);
    }
}
