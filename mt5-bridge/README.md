# GoldAI MT5 Bridge

> **Status: Scaffold / incomplete**  
> Execution is **not production-ready**. The Node route returns clear states:  
> `READY` | `PENDING` | `DISCONNECTED` | `ERROR`.  
> Do **not** enable auto-trading until the Python bridge is fully tested on a **demo** account.

## What this is

Optional bridge between GoldAI signals and MetaTrader 5:

```
Frontend signal → Node /api/mt5 → Python bridge (:5001) → MT5 terminal
```

If the Python process is offline, trades are **not** executed. The API reports `DISCONNECTED`.

## Setup (demo only)

1. Install MetaTrader 5 and log into a **demo** account  
2. `cd mt5-bridge && pip install -r requirements.txt` (if present)  
3. Configure `.env` with MT5 login / server (never commit real passwords)  
4. Run the Python connector on port **5001**  
5. Start the Node backend (`backend/`)

## Health check

```http
GET /api/mt5/health
```

Example when bridge is down:

```json
{
  "status": "degraded",
  "bridge": "DISCONNECTED",
  "executionState": "DISCONNECTED",
  "message": "Python MT5 bridge not reachable on port 5001"
}
```

## Safety rules

- Always test on **demo** first  
- Node must never report success if the bridge is offline  
- Lot size and SL/TP must match broker symbol specs  
- GoldAI confidence is a **score**, not a win probability  

## Architecture

```
┌─────────────────────┐
│   GoldAI Frontend   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Node.js Backend    │  /api/mt5/*
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Python MT5 Bridge  │  :5001
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│   MetaTrader 5      │
└─────────────────────┘
```
