import { createSocket } from "node:dgram";
const s = createSocket("udp4");
s.bind(() => {
  const pkt = Buffer.from("\xff\xff\xff\xff" + (process.argv[2] || "getstatus"), "latin1");
  s.send(pkt, 27960, "127.0.0.1", () => console.log("sent", pkt.toString("latin1")));
});
s.on("message", (m, r) => { console.log("reply:", r, JSON.stringify(m.toString("latin1").slice(0,150))); process.exit(0); });
setTimeout(() => { console.error("FAIL no reply"); process.exit(1); }, 3000);
