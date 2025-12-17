# Moby User Guide

Moby is a self-hosted application that automatically moves cryptocurrency from exchanges to your personal wallets after trades execute.

## How It Works

1. You place limit orders on an exchange (e.g., Kraken)
2. Moby monitors for when those orders fill
3. When fills accumulate above your threshold, Moby automatically withdraws to your saved wallet addresses
4. Funds arrive in your personal wallet without manual intervention

---

## Initial Setup

### 1. Create Your Account

On first launch, you'll be prompted to create a username and password. This protects access to the Moby dashboard.

### 2. Add Exchange API Keys

Navigate to the API Keys section and add your exchange credentials:

1. Click **Add API Key**
2. Select your exchange (Kraken, Gemini, KuCoin, Gate.io)
3. Enter your API Key and Secret
4. Select your account tier (affects rate limits)

**Required API Permissions:**
- Query Funds (balance checking)
- Query Open Orders & Trades
- Withdraw Funds

> **Security Note:** Your API keys are encrypted at rest. Keep a backup of your `.env` file - it contains the encryption key needed to decrypt your credentials.

### 3. Sync Withdrawal Addresses

Before Moby can withdraw, it needs to know your saved wallet addresses:

1. Go to the **Configuration** tab
2. Find your exchange card
3. Click **Sync Addresses**

This pulls the withdrawal addresses you've already saved on the exchange. Moby can only withdraw to addresses you've pre-approved on the exchange itself.

---

## Configuring Assets to Sweep

### Add an Asset

1. Click **Manage Wallets** on your exchange card
2. Click **Configure** on an asset (e.g., ETH)
3. Set your parameters:

| Setting | Description |
|---------|-------------|
| **Sweep Threshold** | Minimum amount before triggering a withdrawal. Must be at least the exchange's minimum withdrawal amount. |
| **Reserve** | Amount to leave on the exchange (useful for trading fees). |
| **Wallet Keys** | Which saved addresses to withdraw to. Multiple = round-robin rotation. |
| **Priority** | Lower number = higher priority when multiple assets are ready. |
| **Cooldown** | Seconds to wait between withdrawals for this asset. |
| **Chunk Size** | Amount per withdrawal. Use the 1x/2x/5x/10x buttons for quick selection based on minimum. |

4. Click **Add Asset**

### Example Configuration

For ETH with a 0.01 minimum withdrawal:
- **Threshold:** 0.01 ETH (triggers as soon as minimum is met)
- **Reserve:** 0 ETH (withdraw everything)
- **Chunk Size:** 0.05 ETH (withdraw in 5x minimum chunks)
- **Cooldown:** 60 seconds

---

## Running the Sweeper

### Start/Stop

Use the **Start Sweeper** / **Stop Sweeper** button in the Sweeper Control section.

- **Green dot** = Running and monitoring for fills
- **Gray dot** = Stopped

### What Happens When Running

1. Moby connects to the exchange via WebSocket for real-time fill notifications
2. When a limit order fills, the received amount is added to a pending balance
3. When pending balance exceeds your threshold, a withdrawal is initiated
4. Moby tracks the withdrawal until it completes

### Dry Run Mode

If enabled in config, Moby will simulate withdrawals without actually submitting them. Useful for testing your configuration.

---

## The Reconcile Button

Click **Reconcile** to manually sync with the exchange. This is useful for:

- **Troubleshooting** - If pending amounts seem wrong
- **After downtime** - If the app was closed during trading activity
- **After manual withdrawals** - If you withdrew directly on the exchange

**What Reconcile does:**
1. Fetches recent trade history from the exchange API
2. Processes any trades that were missed
3. Compares your actual exchange balance to Moby's pending amount
4. Adjusts pending amounts if you withdrew manually

> Reconciliation also runs automatically on app startup and when WebSocket reconnects.

---

## Understanding the Dashboard

### Asset States

Each configured asset shows:
- **Pending Amount** - Accumulated from fills, waiting to be withdrawn
- **Status** - Ready, in cooldown, or in backoff (after failures)

### Recent Fills

Shows trade fills detected by Moby with:
- Asset received
- Amount
- Trade pair and side (buy/sell)

### Withdrawal Jobs

Active and recent withdrawals showing:
- Status (pending, complete, failed)
- Amount and destination
- Exchange reference ID

---

## Troubleshooting

### "No withdrawal addresses found"

Click **Sync Addresses** to pull addresses from your exchange. You must have addresses saved on the exchange first.

### Withdrawals not triggering

Check:
1. Is the sweeper running? (green dot)
2. Is pending amount above threshold?
3. Is the asset in cooldown? (wait for timer)
4. Is the asset in backoff? (previous failure, will retry)

Click **Reconcile** to force a sync if amounts seem wrong.

### "Withdrawal limit reached"

You've hit your exchange's withdrawal limit. Moby will skip withdrawals until the limit resets (usually daily).

### App was closed during trading

No problem - on restart, Moby automatically reconciles trade history and picks up where it left off.

---

## Data Locations

| Platform | Data Directory |
|----------|----------------|
| macOS | `~/Library/Application Support/Moby/` |
| Windows | `%APPDATA%/Moby/` |
| Linux | `~/.config/Moby/` |

**Important files:**
- `moby.db` - Database (balances, jobs, settings)
- `.env` - Encryption key (backup this!)
- Configuration is stored in the application database (no `config.yaml`). A legacy file will be migrated automatically if present on first run.

---

## Tips

1. **Start small** - Test with a small threshold first to verify everything works
2. **Use multiple wallets** - Add several addresses for round-robin distribution
3. **Set reasonable reserves** - Keep some funds for trading fees
4. **Monitor initially** - Watch the first few withdrawals to confirm success
5. **Backup your .env** - Without the encryption key, API credentials can't be recovered
