# Moby

Moby automatically withdraws cryptocurrency from your exchanges to your wallets after trades fill. Instead of manually moving funds after every trade, you choose the assets, destinations, and withdrawal rules, and Moby handles the transfers.

It runs on your own computer with a desktop dashboard for managing exchange connections, wallets, and withdrawals. Supported exchanges include Kraken, Gemini, KuCoin, and Gate.io.

## How it works

1. Connect your exchange account using API credentials.
2. Choose the assets to monitor and your saved withdrawal addresses.
3. Set how much to withdraw, how much to leave on the exchange, and when transfers should happen.
4. Start Moby and follow the activity in the dashboard.

## What you can do

- **Automate withdrawals:** Set thresholds, transfer sizes, reserves, and cooldowns for each asset.
- **Manage destinations:** Choose wallets and set per-wallet withdrawal caps.
- **Monitor activity:** See balances, pending amounts, transfer status, and searchable withdrawal history.
- **Control fees:** Preview estimated fees and optionally set a rolling 24-hour fee budget.
- **Stay informed:** Receive optional Telegram alerts for withdrawals, connection problems, and delays.
- **Pause and review:** Stop new withdrawals, review uncertain transfers, or clear queued amounts you no longer want to withdraw.

## Before moving funds

Start with **dry-run mode** to check your settings without sending withdrawals. Verify the destination address and network before enabling real transfers.

Moby must remain running to monitor activity and submit transfers. Pausing stops new withdrawals; transfers already submitted to an exchange can still complete. Exchange fees, minimums, and holds still apply.

Credentials are encrypted locally. Back up `moby.db` and its accompanying `.env` file together—the encryption key is needed to recover stored credentials.
