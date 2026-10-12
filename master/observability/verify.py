#!/usr/bin/env python3
"""Read-only smoke check for a deployed master dashboard; uses only the standard library."""
import base64
import json
import os
import urllib.parse
import urllib.request

base = os.environ.get("GRAFANA_URL", "https://grafana.q3js.com").rstrip("/")
password = os.environ["GRAFANA_ADMIN_PASSWORD"]
authorization = "Basic " + base64.b64encode(("admin:" + password).encode()).decode()


def get(path):
    request = urllib.request.Request(base + path, headers={"Authorization": authorization})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def query(expression):
    result = get("/api/datasources/proxy/uid/prometheus/api/v1/query?" +
                 urllib.parse.urlencode({"query": expression}))
    assert result["status"] == "success", expression
    return result["data"]["result"]


assert get("/api/health")["database"] == "ok"
dashboard = get("/api/dashboards/uid/q3js-master")["dashboard"]
for panel in dashboard["panels"]:
    if panel["datasource"]["uid"] == "prometheus":
        for target in panel["targets"]:
            query(target["expr"])
assert query('up{job="master"}')[0]["value"][1] == "1", "Master scrape is down"
assert all(sample["value"][1] == "1" for sample in query('up{job="monitoring"}'))
probes = query('probe_success{check=~"Readiness|Public API"}')
assert len(probes) == 2 and all(sample["value"][1] == "1" for sample in probes), "Readiness/public probe failed"
assert query('agroal_active_count{job="master"} / agroal_max_size{job="master"}'), "Database pool metric is missing"
assert float(query('time() - q3js_servers_refresh_completed_timestamp{job="master"}')[0]["value"][1]) < 60
rules = get("/api/v1/provisioning/alert-rules")
assert len(rules) == 9
for rule in rules:
    query(rule["data"][0]["model"]["expr"])
policy = get("/api/v1/provisioning/policies")
assert policy["routes"][0]["mute_time_intervals"] == ["grafana-only"], "External notifications must remain muted"
logs = get("/api/datasources/proxy/uid/loki/loki/api/v1/query_range?" +
           urllib.parse.urlencode({"query": '{service_name="q3js-master"}', "limit": 10}))
assert logs["data"]["result"], "Master logs are missing"
traces = get("/api/datasources/proxy/uid/tempo/api/search?" +
             urllib.parse.urlencode({"q": '{ resource.service.name = "q3js-master" }', "limit": 10}))
assert traces.get("traces"), "Master traces are missing"
print("PASS: dashboard queries, scrape/probes, pool/refresh metrics, alert rules, muted delivery, logs, and traces")
