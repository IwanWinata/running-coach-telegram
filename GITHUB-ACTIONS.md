# 🚀 Garmin AI Coach: GitHub Actions Setup Guide

This guide will walk you through deploying your Garmin AI Coach perfectly on GitHub Actions, complete with Cloudflare bypasses and persistent state management.

## 📌 Prerequisites
1. You have run the script at least once on your local computer successfully to generate the OAuth tokens.
2. Your local repository has a `garmin_tokens` folder containing `oauth1_token.json` and `oauth2_token.json`.

## 🛠 Step 1: Secure Your Secrets Locally
Do **not** commit your tokens to GitHub! Ensure your `.gitignore` file includes the following lines to prevent accidentally leaking your credentials:
```text
garmin_tokens/
garmin_session.json
.env
index.env
```

## 🔐 Step 2: Add GitHub Repository Secrets
GitHub Actions uses an ephemeral virtual machine, so we must inject your tokens and API keys securely through the GitHub UI rather than reading them from a file.

1. Go to your repository on GitHub.
2. Navigate to **Settings** -> **Secrets and variables** -> **Actions**.
3. Click the green **New repository secret** button.
4. Add the following standard secrets one by one:
   - `GARMIN_EMAIL`: Your Garmin email address.
   - `GARMIN_PASSWORD`: Your Garmin password.
   - `TELEGRAM_TOKEN`: Your Telegram Bot API token.
   - `TELEGRAM_CHAT_ID`: Your Telegram Chat ID.
   - `GEMINI_API_KEY`: Your Google Gemini API Key.
5. **The Cloudflare Bypass Tokens**:
   - Open your local `garmin_tokens/oauth1_token.json` file. Copy the entire text block and save it as a new secret named `GARMIN_OAUTH1_TOKEN`.
   - Open your local `garmin_tokens/oauth2_token.json` file. Copy the entire text block and save it as a new secret named `GARMIN_OAUTH2_TOKEN`.

> **💡 Note:** Garmin uses Cloudflare to block automated bots from logging in with an email and password. These two OAuth tokens allow your GitHub Action to completely bypass that block by pretending it's an already-logged-in mobile app!

## ⚙️ Step 3: The Workflow File
Ensure your `.github/workflows/coach.yml` file is fully up to date. This file tells GitHub to run your script every 15 minutes, cache your last workout history, and securely inject your secrets.

```yaml
name: Garmin AI Coach Sync Pipeline

on:
  schedule:
    - cron: '13,28,43,58 * * * *'
  workflow_dispatch:

jobs:
  run-sync:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code Repository
        uses: actions/checkout@v4

      - name: Setup Node.js Environment Runtime
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - name: Fetch and Install Node Modules
        run: npm install

      # This step acts as a "database" to remember the last workout you completed!
      - name: Persist Bot State (lastActivityId)
        uses: actions/cache@v4
        with:
          path: state.json
          key: state-${{ github.run_id }}
          restore-keys: |
            state-

      - name: Run AI Analysis Sync Logic
        run: node index.js
        env:
          GARMIN_EMAIL: ${{ secrets.GARMIN_EMAIL }}
          GARMIN_PASSWORD: ${{ secrets.GARMIN_PASSWORD }}
          TELEGRAM_TOKEN: ${{ secrets.TELEGRAM_TOKEN }}
          TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          GARMIN_OAUTH1_TOKEN: ${{ secrets.GARMIN_OAUTH1_TOKEN }}
          GARMIN_OAUTH2_TOKEN: ${{ secrets.GARMIN_OAUTH2_TOKEN }}
```

## 🏃 Step 4: Push and Test!
1. Commit and push your code to GitHub.
2. Go to the **Actions** tab in your repository.
3. Click on **Garmin AI Coach Sync Pipeline** on the left menu.
4. Click the **Run workflow** dropdown on the right side of the screen and run it manually.
5. Watch the logs! You should see it successfully inject the OAuth tokens, execute your logic, and gracefully shut down!

> **🔄 Maintenance Tip:** Your Garmin OAuth tokens last for roughly 30 days. If your GitHub Action stops working and throws a `429 Too Many Requests` error in a month, it means your tokens expired. Simply run `node index.js` on your local PC again to generate fresh tokens, and update the GitHub Secrets!
