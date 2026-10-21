import { createSocket } from "node:dgram";
const s = createSocket("udp4");
s.on("message", (m, r) => { console.log("reply from", r, JSON.stringify(m.toString("latin1").slice(0,120))); process.exit(0); });
s.send(Buffer.from("\xff\xff\xff\xffgetstatus", "latin1"), 27961, "127.0.0.1", () => console.log("sent"));
setTimeout(() => { console.error("FAIL no reply"); process.exit(1); }, 2000);
