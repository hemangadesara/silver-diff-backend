require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const speakeasy = require("speakeasy");

// SmartAPI library
const { SmartAPI, WebSocketV2 } = require("smartapi-javascript");


const MASTER_URL =
  "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

const API_KEY = process.env.API_KEY;
const CLIENT_CODE = process.env.CLIENT_CODE;
const PIN = process.env.MPIN;
const PORT = process.env.PORT || 7000;

if (!API_KEY || !CLIENT_CODE || !PIN) {
  console.error("Missing API_KEY / CLIENT_CODE / PIN in .env");
  process.exit(1);
}

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

let smartApi;
let jwtToken = null;
let feedToken = null;

const instrumentMap = { current: {}, next: {} };
const stateStore = { current: {}, next: {} };

// ------------------ LOGIN ------------------
async function loginSmartAPI() {
  try {
    smartApi = new SmartAPI({ api_key: API_KEY });

    const mpin = PIN;
    const secret = process.env.TOTP_SECRET;

    console.log("Logging in with MPIN + TOTP...");

    const otp = speakeasy.totp({
      secret: secret,
      encoding: "base32",
    });

    console.log("Generated OTP:", otp);

    const session = await smartApi.generateSession(CLIENT_CODE, mpin, otp);

    const data =
      (session?.data && Object.keys(session.data).length > 0)
        ? session.data
        : session;

    jwtToken =
      data.jwtToken ||
      data.jwt_token ||
      data.accessToken ||
      data.access_token ||
      null;

    feedToken = data.feedToken || data.feed_token || null;

    console.log("jwtToken present:", !!jwtToken);
    console.log("feedToken present:", !!feedToken);

  } catch (err) {
    console.error("SmartAPI login failed:", err.message || err);
    throw err;
  }
}

// ------------------ DISCOVER INSTRUMENTS ------------------
async function discoverInstruments() {
  console.log("Fetching instrument master...");

  const resp = await axios.get(MASTER_URL, { timeout: 30000 });
  const instruments = Array.isArray(resp.data) ? resp.data : [];

  if (!instruments.length) throw new Error("Empty instrument master");

  const today = new Date();

  const parseExpiry = (val) => {
    const cleaned = String(val).replace(/(\d{2})([A-Z]{3})(\d{2,4})/, "$1 $2 $3");
    const d = new Date(cleaned);
    return isNaN(d) ? null : d;
  };

  const mcx = instruments.filter(
    (i) => i.exch_seg === "MCX" && i.instrumenttype === "FUTCOM"
  );

  const stdList = mcx.filter((i) => i.name === "SILVER");
  const miniList = mcx.filter((i) => i.name === "SILVERM");

  const pick = (list) => {
    const sorted = list
      .map((i) => ({ ...i, _expiryDate: parseExpiry(i.expiry) }))
      .filter((i) => i._expiryDate && i._expiryDate >= today)
      .sort((a, b) => a._expiryDate - b._expiryDate);

    return [sorted[0], sorted[1]];
  };

  const [stdCur, stdNext] = pick(stdList);
  const [miniCur, miniNext] = pick(miniList);

  const tokenOf = (i) =>
    String(i.token || i.symboltoken || i.instrument_token);

  instrumentMap.current.standard = tokenOf(stdCur);
  instrumentMap.current.mini = tokenOf(miniCur);
  instrumentMap.next.standard = tokenOf(stdNext);
  instrumentMap.next.mini = tokenOf(miniNext);

  console.log("Auto-discovered tokens:", instrumentMap);
}

// ------------------ WEBSOCKET (FINAL FIXED VERSION) ------------------
async function connectWebSocket() {
  try {
    if (!jwtToken || !feedToken) {
      console.error("Missing jwtToken or feedToken — cannot open WebSocket V2");
      return;
    }

    console.log("Connecting WebSocket V2…");

    const sws = new WebSocketV2({
      clientcode: CLIENT_CODE,
      jwttoken: jwtToken,
      apikey: API_KEY,
      feedtype: feedToken
    });

    // Tick listener **FIRST**
    sws.on("tick", (tick) => {
  if (!tick || !tick.token) return;

  // Clean token → SmartAPI sends it as `"451666"`
  const rawToken = tick.token.replace(/"/g, "").trim();
  const ltp = Number(tick.last_traded_price) / 100; // Convert to real value

  console.log("parsed tick:", rawToken, ltp);

  let slot = null;
  if (rawToken === instrumentMap.current.standard)
    slot = { expiry: "current", type: "standard" };
  else if (rawToken === instrumentMap.current.mini)
    slot = { expiry: "current", type: "mini" };
  else if (rawToken === instrumentMap.next.standard)
    slot = { expiry: "next", type: "standard" };
  else if (rawToken === instrumentMap.next.mini)
    slot = { expiry: "next", type: "mini" };

  io.emit("smartapi:tick", { rawToken, ltp, slot });

  if (!slot) return;

  stateStore[slot.expiry][slot.type] = ltp;

  const s = stateStore[slot.expiry];
  if (s.standard && s.mini) {
    const diff = s.standard - s.mini;
    const pct = s.mini ? (diff / s.mini) * 100 : null;

    io.emit("smartapi:summary", {
      expiry: slot.expiry,
      standard: s.standard,
      mini: s.mini,
      diff,
      pct
    });
  }
});


    sws.on("error", (err) => console.error("WS Error:", err));
    sws.on("close", () => console.warn("WS Closed"));

    sws.connect().then(() => {
      console.log("WebSocket V2 connected.");

      const tokens = [
        instrumentMap.current.standard,
        instrumentMap.current.mini,
        instrumentMap.next.standard,
        instrumentMap.next.mini
      ];

      tokens.forEach((token, i) => {
        const req = {
          correlationID: `silver-${i}`,
          action: 1, // subscribe
          mode: 1,
          exchangeType: 5,
          tokens: [token]  
        };

        console.log("Sending subscription:", req);
        sws.fetchData(req); // NO MODE, NO EXCHANGE TYPE, NO PARAMS
      });
    });

  } catch (e) {
    console.error("connectWebSocket() failed:", e);
  }
}

// ------------------ SOCKET.IO ------------------
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
  socket.emit("info", { instrumentMap });
});

// ------------------ START EVERYTHING ------------------
async function startSmartFlow() {
  try {
    await loginSmartAPI();
    await discoverInstruments();
    await connectWebSocket();
    console.log("SmartAPI live flow initialized.");
  } catch (err) {
    console.error("SmartAPI flow failed:", err.message || err);
  }
}

httpServer.listen(PORT, () => {
  console.log("Server listening on port", PORT);
  startSmartFlow();
});


