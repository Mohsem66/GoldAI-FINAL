# GoldAI — 24/7 Automatic Signal Worker

این سند توضیح می‌دهد که Worker چیست، کجاست، چطور اجرا می‌شود، و چطور مطمئن شوی بدون Browser/Firefox/CMD کار می‌کند.

## Worker دقیقاً کجاست

```
backend/worker/signal-worker.js   ← فایل اصلی اجراشدنی
backend/worker/mt5-client.js      ← اتصال مستقیم HTTP به MT5 Bridge (پورت 5001) — بدون وابستگی به Express
backend/worker/engine-loader.js   ← همون js/engines/*.js فرانت‌اند را داخل Node بارگذاری می‌کند (بدون کپی/بازنویسی منطق)
backend/worker/store.js           ← ذخیره‌سازی atomic روی فایل (JSON)
backend/worker/logger.js          ← لاگ برچسب‌دار [MT5]/[WORKER]/[SIGNAL]/[ERROR]
backend/worker/localstorage-polyfill.js ← جایگزین localStorage برای اینکه js/engines/risk-guard.js بدون تغییر در Node هم کار کند
```

## چرا مستقل از Browser است

Worker یک پروسه‌ی خالص Node.js است (`node backend/worker/signal-worker.js`). هیچ کدی از `index.html`، DOM، یا `js/app.js` صدا زده نمی‌شود. Worker مستقیماً با MT5 Bridge (`http://127.0.0.1:5001`) صحبت می‌کند — **نه از طریق Express backend**. یعنی حتی اگر کل Backend/Express هم پایین باشد، Worker به کارش ادامه می‌دهد و همچنان در `backend/data/signals.json` می‌نویسد. Express فقط این فایل‌ها را **می‌خواند** (`/api/worker/*`) تا Frontend بتواند وضعیت را نشان دهد — Express هرگز خودش Worker را اجرا یا متوقف نمی‌کند.

بستن Firefox، بستن `index.html`، و حتی بستن پنجره‌ی CMD که Backend Express را اجرا کرده، هیچکدام روی یک Worker که با Task Scheduler اجرا شده تأثیری ندارند (بخش بعدی).

## منطق تحلیل مشترک (نه یک نسخه‌ی دوم و جدا)

`engine-loader.js` دقیقاً همان فایل‌های `js/engines/*.js` (EMA, RSI, MACD, ADX, ATR, Volume, S/R, Candles, Structure, Liquidity, Score, ConflictFilter, RiskGuard, TradeManagement) را می‌خواند و در یک `window` جعلی داخل Node اجرا می‌کند — کدی که بازنویسی نشده، **دقیقاً همان فایل‌هاست**. Worker برای ساخت سیگنال، از تابع `buildSignal()` که داخل `js/engines/backtest.js` است استفاده می‌کند (این تابع اکنون export شده — تنها تغییری که در آن فایل داده شد). این دقیقاً همان تابعی است که Real MT5 Backtest هم برای هر کندل صدا می‌زند. یعنی:

```
Historical MT5 Data  → buildSignal() → Backtest
Live MT5 Data        → buildSignal() → 24/7 Worker
Browser (دستی/Auto)  → app.js analyze() (همون Engineها، مسیر جدا برای پشتیبانی از AI Brain/Fundamental که فقط زنده در Browser معنا دارند)
```

> **محدودیت آگاهانه:** `buildSignal()` فقط شامل موتورهای تکنیکال اصلی (EMA/RSI/MACD/ADX/ATR/Volume/S-R/Candles/Structure/Liquidity/HTF/M1) + Score + ConflictFilter است. AI Brain (Meta Filter) و Fundamental/Correlation (که شبیه‌سازی‌شده و فقط در Browser معنا دارند) در این نسخه‌ی Worker/Backtest نیستند — دقیقاً همان تصمیمی که قبلاً برای Backtest گرفته شد، اینجا هم برای هماهنگی حفظ شده.

## RiskGuard در Worker

برخلاف Backtest (که RiskGuard را موقتاً خنثی می‌کند تا همه‌ی سیگنال‌های فرضی را ببیند)، **Worker زنده RiskGuard واقعی را رعایت می‌کند** — چون این سیگنال واقعی و برای اکنون است، نه یک شبیه‌سازی گذشته. وضعیت RiskGuard (سقف روزانه/تعداد معامله) در فایل `backend/worker/data/localstorage-polyfill.json` نگه داشته می‌شود تا بین ری‌استارت‌های Worker هم حفظ شود.

## اجرای دائمی روی Windows Server 2022

### روش پیشنهادی: Task Scheduler (بدون نیاز به نصب پکیج اضافه)

1. Task Scheduler را باز کن → Create Task
2. **General**: نام = `GoldAI Signal Worker`، تیک «Run whether user is logged on or not»
3. **Triggers** → New → Begin the task: **At startup**
4. **Actions** → New:
   - Program/script: `C:\Program Files\nodejs\node.exe`
   - Add arguments: `backend\worker\signal-worker.js`
   - Start in: `C:\GoldAI`
5. **Settings**:
   - ✅ "If the task fails, restart every: 1 minute" — تا 3 بار (یا "Restart the task every X minutes if it fails")
   - ✅ "If the running task does not end when requested, force stop it"
   - ❌ خاموش کردن "Stop the task if it runs longer than" (Worker باید همیشه در حال اجرا بماند)
6. Save. برای تست فوری، روی Task راست‌کلیک → Run.

بعد از Restart سرور، Worker خودش دوباره اجرا می‌شود (Trigger = At startup). اگر Node.js پروسه کرش کند، همان Task Scheduler entry با "Restart on failure" دوباره اجرایش می‌کند.

### روش جایگزین: Windows Service واقعی

اگر ترجیح می‌دهی به‌عنوان یک Service واقعی دیده شود (نه Scheduled Task)، پکیج [`node-windows`](https://www.npmjs.com/package/node-windows) را می‌توان اضافه کرد (`npm install node-windows` داخل `backend/`) و یک اسکریپت نصب کوچک نوشت که `signal-worker.js` را به‌عنوان Service ثبت کند. این روش عمداً در این تحویل پیاده‌سازی نشده تا هیچ وابستگی جدید اجباری اضافه نشود — Task Scheduler برای این نیاز کاملاً کافی است.

## بررسی وضعیت Worker

```
curl http://127.0.0.1:5000/api/worker/status
curl http://127.0.0.1:5000/api/worker/signal/latest
curl http://127.0.0.1:5000/api/worker/journal?limit=20
```

`state` می‌تواند یکی از این‌ها باشد: `RUNNING`, `MT5_DISCONNECTED`, `ERROR`, `STOPPED`.

## بررسی Log

```
backend\worker\logs\worker.log
```

هر خط با یکی از این برچسب‌ها شروع می‌شود: `[MT5]`, `[WORKER]`, `[SIGNAL]`, `[ERROR]`. فایل لاگ در حدود ۵ مگابایت rotate می‌شود (تا ۳ نسخه‌ی قدیمی نگه داشته می‌شود).

## بررسی Signal Journal

فایل واقعی: `backend\data\signals.json` — آرایه‌ای از سیگنال‌ها (هرکدام شامل `id, timestamp, symbol, timeframe, candleTimestamp, signal, price, score, reason, source, executionStatus`). حداکثر ۵۰۰۰ رکورد آخر نگه داشته می‌شود.

Frontend می‌تواند بعداً همین را از `/api/worker/journal` بخواند — نیازی به خواندن مستقیم فایل از Browser نیست (و اصلاً امکانش هم نیست).

## جلوگیری از Duplicate Signal

`backend\worker\data\state.json` آخرین کندل پردازش‌شده برای هر Timeframe را نگه می‌دارد:

```json
{ "lastCandle": { "M5": "XAUUSD.|M5|1788004307", "M15": "XAUUSD.|M15|1788003707" } }
```

کلید = `symbol|timeframe|candleCloseUnixTime`. قبل از هر تحلیل، این کلید چک می‌شود؛ اگر همان کندل قبلاً پردازش شده، تحلیل دوباره اجرا **نمی‌شود** — even بعد از ری‌استارت Worker (چون این فایل روی دیسک است، نه در حافظه).

## رفع خطاهای رایج MT5

| خطا | معنی | راه‌حل |
|-----|------|--------|
| `bridge unreachable: ECONNREFUSED` | Python bridge (`mt5_connector.py`) اجرا نیست یا پورت اشتباه است | `mt5-bridge` را اجرا کن، `MT5_BRIDGE_URL` را چک کن |
| `MT5 reports not connected` | Bridge بالاست ولی به MT5 وصل نیست | ترمینال MT5 را باز/لاگین کن؛ `mt5-bridge/.env` را چک کن |
| `(-6, 'Terminal: Authorization failed')` | تلاش برای login مجدد روی session معتبر (رفع‌شده — نگاه کن `MT5-CONNECTION-NOTES.md`) | معمولاً دیگر رخ نمی‌دهد؛ اگر رخ داد، `MT5_LOGIN`/`MT5_SERVER` در `.env` را با حساب واقعی چک کن |
| `symbol tick not found` | Symbol Mapping هیچ‌کدام از کاندیدها را پیدا نکرد | مطمئن شو `XAUUSD.` دقیقاً در MarketWatch بروکر با همین نام هست |
| `not enough real candles yet` | تاریخچه‌ی کافی هنوز از MT5 دریافت نشده (warmup) | چند دقیقه صبر کن یا `WORKER_CANDLE_COUNT` را بررسی کن |

## نصب و اجرا (خلاصه)

```bash
# 1) MT5 Bridge
cd mt5-bridge
pip install -r requirements.txt --break-system-packages
python mt5_connector.py

# 2) Backend (برای API نمایش وضعیت — اختیاری برای خود Worker)
cd backend
npm install
npm start

# 3) 24/7 Signal Worker — این پروسه‌ای است که باید همیشه در حال اجرا بماند
cd backend
node worker/signal-worker.js
```

برای اجرای واقعی ۲۴/۷، مرحله‌ی ۳ را طبق بخش «Task Scheduler» بالا تنظیم کن — اجرای دستی در یک پنجره‌ی CMD باز فقط برای تست است، نه برای Production.

## Auto Trading

`AUTO_TRADING_ENABLED` در `js/config.js` همچنان `false` است و در `signal-worker.js` **اصلاً خوانده نمی‌شود** — Worker هیچ‌جا `order_send`/`/execute-trade` را صدا نمی‌زند. `executionEligible` در هر سیگنال ذخیره‌شده همیشه `false` و `executionStatus` همیشه `"NOT_EXECUTED"` است.
