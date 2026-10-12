package com.q3js.master.server.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.q3js.master.server.client.ServerStatusClient;
import com.q3js.master.server.domain.RegisteredServer;
import com.q3js.master.server.domain.StoredServer;
import com.q3js.master.server.dto.HeartbeatRequest;
import com.q3js.master.server.dto.ServerInfo;
import com.q3js.master.server.dto.ServerResponse;
import com.q3js.master.server.repository.ServerRepository;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.quarkus.scheduler.Scheduled;
import jakarta.enterprise.context.ApplicationScoped;
import org.eclipse.microprofile.config.inject.ConfigProperty;
import org.jboss.logging.Logger;

import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

@ApplicationScoped
public class ServerService {
    private static final Logger LOG = Logger.getLogger(ServerService.class);
    private static final String PIETER_HOST = "q3.pieter.com";
    private static final int DEFAULT_SECURE_PROXY_PORT = 443;

    private final ServerRepository repository;
    private final ServerStatusClient statusClient;
    private final ObjectMapper objectMapper;
    private final Duration heartbeatTtl;
    private final MeterRegistry metrics;
    private final Counter prunedServers;
    private volatile int registeredServers;
    private volatile int staleStatuses;
    private volatile long refreshCompletedAt;

    public ServerService(
        ServerRepository repository,
        ServerStatusClient statusClient,
        ObjectMapper objectMapper,
        @ConfigProperty(name = "q3js.master.heartbeat-ttl") Duration heartbeatTtl,
        MeterRegistry metrics
    ) {
        this.repository = repository;
        this.statusClient = statusClient;
        this.objectMapper = objectMapper;
        this.heartbeatTtl = heartbeatTtl;
        this.metrics = metrics;
        prunedServers = metrics.counter("q3js.servers.pruned");
        metrics.gauge("q3js.servers.registered", this, service -> service.registeredServers);
        metrics.gauge("q3js.servers.status.stale", this, service -> service.staleStatuses);
        metrics.gauge("q3js.servers.refresh.completed.timestamp", this, service -> service.refreshCompletedAt);
    }

    public void register(HeartbeatRequest heartbeat, boolean official) {
        RegisteredServer server = repository.upsert(new RegisteredServer(
            heartbeat.targetHost(),
            heartbeat.proxyPort(),
            heartbeat.targetPort(),
            heartbeat.secure(),
            official,
            OffsetDateTime.now()
        ));
        metrics.counter("q3js.heartbeats.accepted", "classification", official ? "official" : "community").increment();
        refresh(server);
    }

    public List<ServerResponse> servers() {
        return repository.findAll().stream()
            .map(this::response)
            .flatMap(Optional::stream)
            .sorted(
                Comparator.comparing(ServerResponse::official).reversed()
                    .thenComparing(Comparator.comparingInt(ServerService::realPlayerCount).reversed())
                    .thenComparingInt(ServerService::officialGameTypePriority)
            )
            .toList();
    }

    public int playerCount() {
        return playerCounts().players();
    }

    public boolean isListedServer(String serverId) {
        return servers().stream()
            .anyMatch(server -> serverId.equals(server.host() + ":" + server.proxyPort()));
    }

    public PlayerCounts playerCounts() {
        int players = 0;
        int bots = 0;
        for (ServerResponse server : servers()) {
            if (server.info().users() == null) {
                continue;
            }
            for (var user : server.info().users()) {
                if (user.ping() == 0) {
                    bots++;
                } else if (user.ping() > 0) {
                    players++;
                }
            }
        }
        return new PlayerCounts(players, bots);
    }

    @Scheduled(
        every = "${q3js.master.refresh-every}",
        concurrentExecution = Scheduled.ConcurrentExecution.SKIP
    )
    void refreshServers() {
        addIfMissing(PIETER_HOST, DEFAULT_SECURE_PROXY_PORT, true);

        List<StoredServer> servers = repository.findAll();
        int stale = 0;
        for (StoredServer stored : servers) {
            if (!refresh(stored.server()) && (stored.infoFetchedAt() == null
                || stored.infoFetchedAt().isBefore(OffsetDateTime.now().minusSeconds(30)))) {
                stale++;
            }
        }
        registeredServers = servers.size();
        staleStatuses = stale;
        refreshCompletedAt = System.currentTimeMillis() / 1000;
    }

    @Scheduled(
        every = "${q3js.master.prune-every}",
        concurrentExecution = Scheduled.ConcurrentExecution.SKIP
    )
    void pruneServers() {
        int deleted = repository.deleteOlderThan(OffsetDateTime.now().minus(heartbeatTtl));
        if (deleted > 0) {
            prunedServers.increment(deleted);
            LOG.infof("Pruned %d stale Q3JS server(s)", deleted);
        }
    }

    private void addIfMissing(String host, int proxyPort, boolean secure) {
        var server = new RegisteredServer(
            host,
            proxyPort,
            0,
            secure,
            false,
            OffsetDateTime.now()
        );
        if (repository.insertIfMissing(server)) {
            LOG.info("Adding static community server");
        }
    }

    private boolean refresh(RegisteredServer server) {
        Optional<ServerInfo> info = statusClient.query(server);
        if (info.isEmpty()) {
            return false;
        }
        try {
            repository.updateInfo(server, objectMapper.writeValueAsString(info.get()), OffsetDateTime.now());
            return true;
        } catch (JsonProcessingException exception) {
            LOG.error("Unable to serialize server status");
            return false;
        }
    }

    private Optional<ServerResponse> response(StoredServer stored) {
        if (stored.infoJson() == null || stored.infoJson().isBlank()) {
            return Optional.empty();
        }
        try {
            return Optional.of(new ServerResponse(
                stored.server().host(),
                stored.server().proxyPort(),
                stored.server().targetPort(),
                stored.server().secure(),
                stored.server().official(),
                objectMapper.readValue(stored.infoJson(), ServerInfo.class)
            ));
        } catch (JsonProcessingException exception) {
            LOG.warn("Ignoring invalid stored server status");
            return Optional.empty();
        }
    }

    private static int realPlayerCount(ServerResponse server) {
        if (server.info().users() == null) {
            return 0;
        }
        return (int) server.info().users().stream()
            .filter(user -> user.ping() > 0)
            .count();
    }

    private static int officialGameTypePriority(ServerResponse server) {
        if (!server.official()) {
            return 0;
        }
        return switch (server.info().g_gametype()) {
            case 0 -> 0;
            case 4 -> 1;
            default -> 2;
        };
    }

    public record PlayerCounts(int players, int bots) {
    }
}
