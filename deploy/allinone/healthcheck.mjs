// Health of the all-in-one container: the gateway answers /healthz (which
// also asks the game server for its status) and Caddy answers on port 80.
// Exit 0 = healthy. Used by the image HEALTHCHECK and start.sh's watchdog.
const check = async (url, ok = (r) => r.ok) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: "manual" });
  if (!ok(response)) throw new Error(`${url}: HTTP ${response.status}`);
};
try {
  await check(`http://127.0.0.1:${process.env.GATEWAY_PORT || 8080}/healthz`);
  // Caddy's site port: any answer short of a 5xx (including the http->https
  // redirect when it terminates TLS itself) means it is serving
  await check("http://127.0.0.1/", (r) => r.status < 500);
  process.exit(0);
} catch (error) {
  console.error(`unhealthy: ${error && error.message || error}`);
  process.exit(1);
}
