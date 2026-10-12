# Q3JS master observability

Production Grafana: https://grafana.q3js.com/d/q3js-master. Log in as `admin`;
the generated password is stored as `GRAFANA_ADMIN_PASSWORD` in the Dokploy
Q3JS production **observability** Compose service. No credentials belong in Git.

The stack runs Grafana, Prometheus, Loki, Tempo, and Alloy. Only Grafana and
Alloy join `dokploy-network`; all storage backends use a separate Compose network.
No host ports are published. Dokploy routes HTTPS to Grafana port 3000.
Alloy receives OTLP on 4317 and scrapes the master's private port 9000 every
15 seconds. Prometheus receives these samples through internal remote write
and scrapes the monitoring services directly. Alloy also probes the master's
database readiness and public status endpoint.

## Configuration and startup

The master image includes instrumentation, but export defaults to disabled.
Set these variables on the production master, preserving its other settings:

```dotenv
Q3JS_TELEMETRY_DISABLED=false
Q3JS_ENVIRONMENT=production
Q3JS_OTLP_ENDPOINT=http://q3js-observability-alloy:4317
```

HTTP/JVM/database/scheduler metrics are automatic. The application also records
successful ingestion, official/community heartbeats, pruned servers, and status
query duration/outcome. Snapshot gauges update after a completed refresh; a
status is stale after 30 seconds without a successful fetch. Scraping never
queries the database or polls game servers. `agroal_max_size` supplies the
configured pool capacity for the saturation ratio.

Metrics are served at `http://<master-service>:9000/q/metrics`. Keep port 9000
internal. Existing health/OpenAPI/Swagger endpoints remain on application port
8080; `/api/status` is a process response, while `/q/health/ready` checks the DB.

To deploy the stack through Dokploy, use this repository with Compose path
`master/observability/compose.yml`, disable automatic deployments, and set a
random `GRAFANA_ADMIN_PASSWORD` in the Compose environment. Add the HTTPS domain
`grafana.q3js.com`, service `grafana`, port `3000`, Let's Encrypt certificate.
The master defaults in `.env.example` target the production Dokploy service.
Deploy the stack before enabling master export. Verify fresh CPU/RAM/disk
headroom and DNS before every initial rollout.

For local validation, create `dokploy-network`, use a separate Compose project,
and supply the variables in `.env.example`. An optional Compose override may
publish Grafana and OTLP **on loopback only** and target a locally packaged
master via `host.docker.internal`. Local dev/tests do not export unless explicitly
enabled. Do not attach a test master to the production collector.

## Privacy, correlation, and retention

Loki indexes only service and environment. Trace/span IDs, log category, version,
and exception type remain searchable metadata. Click a log's `trace_id` to open
Tempo, or use a trace's Logs link to return to Loki. Unsampled requests can have
log trace IDs with no retained trace; production retains 10% of root traces.
An incoming sampled trace context is respected.

Alloy allowlists trace/resource/log attributes, keeps HTTP route templates,
renames database spans, and drops SQL, headers, raw URLs, IPs, exception messages,
and stack traces. Application INFO/WARN/ERROR messages contain no player or
server identifiers. Framework log bodies are replaced with a safe summary;
the logger and exception type remain available. Detailed framework errors are
available only in private Dokploy stdout logs, which should have restricted
access. jOOQ's SQL/parameter logger is disabled.

Metrics use bounded route/outcome/type/classification labels. Retention is 15
days or 10 GB for metrics (whichever is reached first), 7 days for logs, and 3
days for traces. Named volumes survive container replacement. Loki/Tempo have
retention limits rather than hard disk quotas; check disk growth in Dokploy.
The stack's combined memory limits total 4 GB. It has no Docker socket access.
Application export and collector buffering are bounded and asynchronous; prolonged
collector outages can drop telemetry without interrupting requests.

## Alerts and verification

Nine Grafana-managed rules cover readiness/reachability, master and monitoring
scrapes, HTTP errors/latency, heap/pool pressure, stalled refreshes, and status
query failures. Rules evaluate every minute; descriptions link back to this
runbook and the dashboard. HTTP error/query failure rules require minimum
traffic. Empty latency/error-rate samples are healthy when no requests occurred.
Other missing operational metrics alert. Probe failure and missing scrape rules
wait two minutes; heap/pool/latency rules wait ten minutes.

Notification delivery is deliberately muted all day by the `grafana-only`
policy. Firing and resolved states remain visible in Grafana. The unused local
email receiver is required by Grafana provisioning; SMTP is not configured.
When a notification channel is requested, replace the contact point and remove
the mute interval together. Never unmute the placeholder receiver alone.

Run the read-only smoke check with the password provided through the environment:

```shell
GRAFANA_URL=https://grafana.q3js.com python3 master/observability/verify.py
```

It checks every dashboard/rule query, scrape/probes, pool capacity and refresh
age, policy, and the presence of logs/traces. It never prints the password.
Application regression tests run with `make master`; if local ports are occupied,
use `./master/mvnw -f master/pom.xml package -Dquarkus.http.test-port=0
-Dquarkus.management.test-port=0` on one command line.

For a local failure drill, stop only the isolated test DB, confirm readiness
becomes 503 and the probe alert fires, restart it, and confirm resolution. Stop
Alloy temporarily and confirm `/api/status` remains 200. Restart monitoring
services and confirm dashboards, samples, logs, traces, and admin login persist.

## Troubleshooting and rollback

- **Missing metrics:** check Alloy's master scrape, internal service DNS, port
  9000, and the Prometheus remote-write receiver. Check `up` and sample timestamps.
- **Missing logs/traces:** check master export variables and Alloy receiver/exporter
  health. Check collector refusal/failure metrics. A trace can be absent due to
  sampling; use a known sampled trace only for controlled diagnostic requests.
- **Database readiness/pool alerts:** inspect the datasource and private master
  logs, query latency, and blocked connections. Do not restart the live DB as a
  diagnostic step.
- **Refresh alerts:** inspect scheduler errors and status-query latency/failure
  metrics. One unreachable community gateway does not make master readiness fail.
- **Grafana login:** read the password in Dokploy's Compose environment. Changing
  that variable does not rotate the password of an existing persisted account;
  use Grafana's supported admin password reset procedure.

Roll back the master using the previous successful Dokploy deployment/image,
then disable export if necessary. Do not delete monitoring volumes. Restore a
previous monitoring config/image and redeploy with the same Compose identity
and volumes. This change introduces no database migrations. Keep staging's
branch/deployment untouched when releasing the isolated production change.

Monitoring shares the application host and cannot notify you of a complete
host outage. An independent external uptime monitor is needed for that coverage.
