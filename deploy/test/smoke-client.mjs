// Smoke test: emulate a browser WebSocket client the way Emscripten's SOCKFS
// does (subprotocol "binary", one binary frame per UDP datagram) and ask the
// game server for status like Quake 3 does.
import { WebSocket } from "ws";

const url = process.argv[2] || "ws://127.0.0.1:8080/ws";

// "\xff\xff\xff\xffgetstatus" - out-of-band Q3 request
const GETSTATUS = Buffer.from("\xff\xff\xff\xffgetstatus", "latin1");
const GETINFOPREFIX = Buffer.from("\xff\xff\xff\xffgetInfo", "latin1");

const ws = new WebSocket(url, { protocols: ["binary"] });
let got = false;

const bail = setTimeout(() => {
  console.error("FAIL: no response within 3s");
  process.exit(1);
}, 3000);

ws.on("open", () => {
  console.log("ws open -> sending getstatus");
  ws.send(GETSTATUS, { binary: true });
});
ws.on("message", (data, isBinary) => {
  const text = !isBinary ? String(data) : Buffer.from(data).toString("latin1");
  console.log("got response:", JSON.stringify(text.slice(0, 200)));
  got = true;
  clearTimeout(bail);
  ws.close(1000, "bye");
  process.exit(0);
});
ws.on("error", (e) => { console.error("ws error:", e.message); process.exit(1); });
