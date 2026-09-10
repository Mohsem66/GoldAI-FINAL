# GoldAI — MT5 Connection Notes

این فایل تنظیمات درست حساب/سرور/سیمبل و دلایل چند تصمیم مهم را ثبت می‌کند تا در آینده دوباره گم نشوند.

## حساب صحیح

- **Login:** `49451`
- **Server:** `ToraFx-Trade`
- **مسیر ترمینال (Windows):** `C:\Program Files\MetaTrader 5\terminal64.exe`

این سه مقدار در `mt5-bridge/.env` تنظیم می‌شوند (`MT5_LOGIN`, `MT5_SERVER`, `MT5_PATH`) — هرگز در کد هاردکد نشده‌اند.

## سیمبل صحیح

نماد طلا در این بروکر **`XAUUSD.`** است (با یک نقطه در انتها) — نه `XAUUSD` ساده. این دو، دو سیمبل متفاوت در MT5 هستند؛ اگر با `XAUUSD` (بدون نقطه) درخواست بدهی، این بروکر ممکن است `symbol_info`/`symbol_info_tick` را `None` برگرداند.

مسیر مرکزی مدیریت این تفاوت: `mt5-bridge/mt5_connector.py` → توابع `resolve_symbol_tick()` و `resolve_symbol_info()`. هر endpoint (`/current-price`, `/symbol-info`, `/candles`, `/execute-trade`) از همین دو تابع استفاده می‌کند — دیگر candidate-list جدا در هر endpoint نیست. ترتیب امتحان:

```
[درخواست‌شده, درخواست‌شده بدون "/", "XAUUSD.", "XAUUSD", "GOLD"]
```

اولین سیمبلی که MT5 بشناسد استفاده می‌شود و در پاسخ (`symbol` در JSON) مشخص است کدام بوده.

پیش‌فرض کل پروژه (`js/config.js → SYMBOL` و `mt5-bridge/mt5_connector.py → DEFAULT_SYMBOL`) روی `"XAUUSD."` است.

## پورت‌ها و مسیر قیمت

- **MT5 Bridge (Python/Flask):** `http://127.0.0.1:5001`
- **Backend (Node/Express):** `http://127.0.0.1:5000`
- **Frontend:** `http://127.0.0.1:8080` (یا هر استاتیک‌سرور دیگر)

مسیر صحیح قیمت (Source of Truth):

```
Frontend (js/core/data.js)
  → Backend  GET /api/mt5/current-price?symbol=XAUUSD.
    → Bridge GET /current-price?symbol=XAUUSD.
      → MetaTrader5.symbol_info_tick("XAUUSD.")
        → Bid / Ask / Mid
```

این مسیر **جایگزین Twelve Data یا هیچ fallback عمومی نمی‌شود** وقتی MT5 در دسترس است. اگر MT5 قطع باشد، `js/core/data.js → loadPrice()` قیمت قبلی را جعل/جایگزین نمی‌کند؛ `dataMode` را به `"offline"` (یا `"demo"` اگر هرگز قیمتی دریافت نشده) می‌برد و UI وضعیت را واضح نشان می‌دهد. `js/engines/conflict-filter.js` هم در همین حالت سیگنال معاملاتی را به `WAIT` می‌برد.

## خطای Authorization -6 چه بود و چرا حل شد

قبلاً `ensure_connected()` بعد از `mt5.initialize()` موفق، **همیشه** دوباره `mt5.login()` را صدا می‌زد — حتی وقتی ترمینال از قبل توسط خود کاربر با همان حساب باز و لاگین بود. این کار باعث خطای:

```
(-6, 'Terminal: Authorization failed')
```

می‌شد، چون یک session از قبل معتبر را دوباره authorize می‌کرد.

**راه‌حل:** بعد از `initialize()`، ابتدا `mt5.account_info()` چک می‌شود. اگر حساب فعلی ترمینال از نظر `login` و `server` (بدون حساسیت به حروف بزرگ/کوچک) با مقادیر `.env` یکی بود، همان session معتبر پذیرفته می‌شود و `mt5.login()` اصلاً اجرا نمی‌شود. `mt5.login()` فقط زمانی اجرا می‌شود که یا session فعلی نبود، یا حساب/سرور فعلی با انتظار مطابقت نداشت.

## چرا کندل «در حال تشکیل» جدا شده

`copy_rates_from_pos(symbol, tf, 0, count)` همیشه کندل هنوز-بازِ فعلی را هم برمی‌گرداند (چون `pos=0` یعنی «الان»). این کندل هر لحظه در حال تغییر است و اگر به‌عنوان کندل بسته به موتورهای تحلیل/بک‌تست داده شود، باعث محاسبه اشتباه اندیکاتورها می‌شود. `mt5-bridge/mt5_connector.py → /candles` این کندل آخر را قبل از پاسخ‌دادن حذف می‌کند (با مقایسه زمان بسته‌شدنش با تیک لحظه‌ای) و همچنین از duplicate/out-of-order candle جلوگیری می‌کند.

## تست سریع اتصال

```
curl http://127.0.0.1:5001/health
# انتظار: {"status":"online","connected":true,"executionState":"READY", ...}

curl "http://127.0.0.1:5001/current-price?symbol=XAUUSD."
# انتظار: {"status":"ok","symbol":"XAUUSD.","price":...,"bid":...,"ask":...}

curl "http://127.0.0.1:5000/api/mt5/current-price?symbol=XAUUSD."
# همان قیمت، از پشتِ backend
```

## روش اجرای پروژه

1. **MetaTrader 5** را باز کن و با حساب `49451` / `ToraFx-Trade` لاگین کن (یا مطمئن شو `.env` مقادیر درست را دارد تا Bridge خودش لاگین کند).
2. **Bridge:** `cd mt5-bridge && pip install -r requirements.txt && python mt5_connector.py`
3. **Backend:** `cd backend && npm install && npm start`
4. **24/7 Signal Worker:** `cd backend && node worker/signal-worker.js` — مستقل از Frontend/Browser اجرا می‌شود؛ جزئیات کامل در `24H-AUTO-SIGNAL.md`.
5. **Frontend:** فایل `index.html` را از یک static server باز کن (یا مستقیم در مرورگر، اگر CORS اجازه بدهد).
6. بررسی قیمت زنده در خود صفحه — بج داده باید `LIVE` نشان دهد، نه `DEMO`/`MT5 OFFLINE`.

## اتصال به Worker 24/7

اصلاح اتصال (بخش بالا) و Symbol Mapping مرکزی، پایه‌ی هر دو مصرف‌کننده‌ی زیر هستند و هیچ‌کدام دوباره پیاده‌سازی نشدند:

- **Real MT5 Backtest** (`js/engines/backtest.js`) — روی داده‌ی تاریخی
- **24/7 Automatic Signal Worker** (`backend/worker/signal-worker.js`) — روی داده‌ی زنده، مستقل از Browser

هر دو از همان `buildSignal()` (اکنون export شده از `backtest.js`) و همان `resolve_symbol_tick`/`resolve_symbol_info` استفاده می‌کنند. جزئیات کامل Worker در `24H-AUTO-SIGNAL.md`.
