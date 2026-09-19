//! GUI-compatible ownTrades stream. A fresh REST token is requested on each reconnect.
use crate::{
    model::{amount, text},
    vault::Secret,
};
use anyhow::{Context, Result, bail, ensure};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::mpsc,
    time::{Instant, timeout},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

pub(crate) enum Event {
    Connected,
    Trades(Vec<(String, Value)>),
    Disconnected,
}
pub(crate) struct Update {
    pub generation: u64,
    pub event: Event,
}
#[derive(Default)]
struct Feed {
    subscribed: bool,
    sequence: Option<u64>,
}
impl Feed {
    fn parse(&mut self, value: Value) -> Result<Option<Event>> {
        if value.is_object() {
            match value["event"].as_str() {
                Some("subscriptionStatus") => {
                    ensure!(
                        value["status"] == "subscribed"
                            && value["subscription"]["name"] == "ownTrades",
                        "websocket subscription rejected"
                    );
                    self.subscribed = true;
                    return Ok(Some(Event::Connected));
                }
                Some("heartbeat" | "pong" | "systemStatus") => return Ok(None),
                _ => bail!("unexpected websocket control message"),
            }
        }
        ensure!(
            self.subscribed,
            "trade data before subscription acknowledgement"
        );
        let data = value.as_array().context("invalid websocket message")?;
        ensure!(
            data.len() == 3 && data[1] == "ownTrades",
            "unexpected websocket channel"
        );
        let sequence = data[2]["sequence"]
            .as_u64()
            .context("missing websocket sequence")?;
        if let Some(previous) = self.sequence {
            ensure!(
                previous.checked_add(1) == Some(sequence),
                "websocket sequence gap"
            );
        }
        self.sequence = Some(sequence);
        let batch = data[0].as_array().context("invalid websocket trades")?;
        ensure!(
            batch.len() <= 1000,
            "websocket trade batch exceeds size limit"
        );
        let mut trades = Vec::new();
        for item in batch {
            for (id, trade) in item.as_object().context("invalid websocket trade")? {
                text(id, "trade ID")?;
                for field in ["time", "vol", "cost", "fee"] {
                    amount(trade[field].as_str().context("invalid websocket amount")?)?;
                }
                ensure!(
                    matches!(trade["type"].as_str(), Some("buy" | "sell")),
                    "invalid websocket trade side"
                );
                trades.push((id.clone(), trade.clone()));
            }
        }
        Ok(Some(Event::Trades(trades)))
    }
}
pub(crate) async fn run(
    token: Secret,
    generation: u64,
    cancelled: Arc<AtomicBool>,
    events: mpsc::Sender<Update>,
) {
    let _ = session(
        "wss://ws-auth.kraken.com",
        token,
        generation,
        &cancelled,
        &events,
    )
    .await;
    let _ = events
        .send(Update {
            generation,
            event: Event::Disconnected,
        })
        .await;
}
async fn session(
    url: &str,
    token: Secret,
    generation: u64,
    cancelled: &AtomicBool,
    events: &mpsc::Sender<Update>,
) -> Result<()> {
    let config = WebSocketConfig::default()
        .max_message_size(Some(512 * 1024))
        .max_frame_size(Some(512 * 1024));
    let (mut socket, _) = timeout(
        Duration::from_secs(20),
        connect_async_with_config(url, Some(config), false),
    )
    .await??;
    if cancelled.load(Ordering::SeqCst) {
        return Ok(());
    }
    socket.send(Message::Text(json!({"event":"subscribe","subscription":{"name":"ownTrades","token":token.0,"snapshot":false,"consolidate_taker":false}}).to_string().into())).await?;
    drop(token);
    let opened = Instant::now();
    let mut last = Instant::now();
    let mut ping = Instant::now();
    let mut feed = Feed::default();
    let mut interval = tokio::time::interval(Duration::from_millis(250));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _=interval.tick()=>{
                if cancelled.load(Ordering::SeqCst){return Ok(());}
                ensure!(last.elapsed()<Duration::from_secs(60),"websocket heartbeat timeout");
                ensure!(feed.subscribed || opened.elapsed()<Duration::from_secs(20),"websocket subscription timeout");
                if ping.elapsed()>=Duration::from_secs(10){timeout(Duration::from_secs(5),socket.send(Message::Text("{\"event\":\"ping\"}".into()))).await??;ping=Instant::now();}
            }
            message=socket.next()=>{
                let message=message.context("websocket closed")??;
                match message {
                    Message::Text(raw)=>{last=Instant::now();if let Some(event)=feed.parse(serde_json::from_str(&raw)?)? {timeout(Duration::from_secs(5),events.send(Update{generation,event})).await??;}},
                    Message::Ping(bytes)=>{last=Instant::now();socket.send(Message::Pong(bytes)).await?;},
                    Message::Pong(_)=>last=Instant::now(),
                    Message::Close(_)=>bail!("websocket closed"),
                    _=>bail!("unexpected websocket frame"),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn acknowledgement_and_sequence_gaps_require_recovery() {
        let mut feed = Feed::default();
        assert!(feed.parse(json!([[],"ownTrades",{"sequence":1}])).is_err());
        assert!(matches!(feed.parse(json!({"event":"subscriptionStatus","status":"subscribed","subscription":{"name":"ownTrades"}})).unwrap(),Some(Event::Connected)));
        assert!(matches!(
            feed.parse(json!([[],"ownTrades",{"sequence":40}])).unwrap(),
            Some(Event::Trades(_))
        ));
        assert!(feed.parse(json!([[],"ownTrades",{"sequence":42}])).is_err());
        assert!(
            feed.parse(json!({"event":"subscriptionStatus","status":"error"}))
                .is_err()
        );
    }
}
