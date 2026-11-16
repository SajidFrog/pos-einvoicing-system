# POS & E-Invoicing System for Small Local Businesses

A full-stack point-of-sale and automated digital invoicing web application designed to help small merchants replace paper ledgers and manual tax calculations with structured transaction records and live inventory analytics.

## Key Features
- **Automated E-Invoicing Engine:** Generates sequential, compliant digital receipts (`INV-YYYY-XXXX`) with itemized tax breakdowns and logs structured sales records.
- **Configurable Tax-Calculation Module:** Dynamically applies localized VAT/tax presets or custom rates at checkout to streamline compliance reporting.
- **Low-Latency Analytics Dashboard:** Tracks daily revenue, gross profit, profit margin percentages, and triggers proactive low-stock alerts with one-click restocking.

## Tech Stack
- **Frontend:** React 18, JavaScript (ES6+), HTML5/CSS3
- **Backend:** Node.js, Express
- **Database:** PostgreSQL (`db/schema.sql`) with automatic in-memory fallback for zero-config local testing

## Local Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. *(Optional)* Configure PostgreSQL by copying `.env.example` to `.env`, setting `DATABASE_URL`, and running `db/schema.sql`.
3. Start the application:
   ```bash
   npm start
   ```
4. Open `http://localhost:3000` in your browser.