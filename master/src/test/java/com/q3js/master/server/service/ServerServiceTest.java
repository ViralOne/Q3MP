package com.q3js.master.server.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.q3js.master.server.client.ServerStatusClient;
import com.q3js.master.server.domain.RegisteredServer;
import com.q3js.master.server.domain.StoredServer;
import com.q3js.master.server.repository.ServerRepository;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ServerServiceTest {
    @Test
    void recordsSnapshotsPruningAndAcceptedHeartbeatsWithoutPollingOnScrape() {
        var registry = new io.micrometer.core.instrument.simple.SimpleMeterRegistry();
        var repository = org.mockito.Mockito.mock(ServerRepository.class);
        var client = org.mockito.Mockito.mock(ServerStatusClient.class);
        var now = OffsetDateTime.now();
        var old = new RegisteredServer("203.0.113.7", 27961, 27960, false, false, now);
        var recent = new RegisteredServer("private-host", 27962, 27960, false, true, now);
        org.mockito.Mockito.when(repository.findAll()).thenReturn(List.of(
            new StoredServer(old, "{}", now.minusMinutes(1)),
            new StoredServer(recent, "{}", now)
        ));
        org.mockito.Mockito.when(client.query(org.mockito.ArgumentMatchers.any())).thenReturn(java.util.Optional.empty());
        org.mockito.Mockito.when(repository.deleteOlderThan(org.mockito.ArgumentMatchers.any())).thenReturn(3);
        org.mockito.Mockito.when(repository.upsert(org.mockito.ArgumentMatchers.any())).thenReturn(old);
        var service = new ServerService(repository, client, new ObjectMapper(), Duration.ofMinutes(5), registry);
        service.refreshServers();
        org.mockito.Mockito.clearInvocations(repository, client);
        assertEquals(2, registry.get("q3js.servers.registered").gauge().value());
        assertEquals(1, registry.get("q3js.servers.status.stale").gauge().value());
        assertTrue(registry.get("q3js.servers.refresh.completed.timestamp").gauge().value() > 0);
        org.mockito.Mockito.verifyNoInteractions(repository, client);
        service.pruneServers();
        assertEquals(3, registry.get("q3js.servers.pruned").counter().count());
        var heartbeat = new com.q3js.master.server.dto.HeartbeatRequest("private-host", 27961, 27960, false);
        service.register(heartbeat, true);
        assertEquals(1, registry.get("q3js.heartbeats.accepted").tag("classification", "official").counter().count());
        org.mockito.Mockito.when(repository.upsert(org.mockito.ArgumentMatchers.any())).thenThrow(new IllegalStateException());
        org.junit.jupiter.api.Assertions.assertThrows(IllegalStateException.class, () -> service.register(heartbeat, true));
        assertEquals(1, registry.get("q3js.heartbeats.accepted").counter().count());
        long completedAt = (long) registry.get("q3js.servers.refresh.completed.timestamp").gauge().value();
        org.mockito.Mockito.when(repository.findAll()).thenThrow(new IllegalStateException());
        org.junit.jupiter.api.Assertions.assertThrows(IllegalStateException.class, service::refreshServers);
        assertEquals(completedAt, registry.get("q3js.servers.refresh.completed.timestamp").gauge().value());
    }

    @Test
    void addsPieterAsASecureCommunityServerBeforeRefreshing() {
        var repository = new ServerRepository(null) {
            private RegisteredServer inserted;

            @Override
            public boolean insertIfMissing(RegisteredServer server) {
                inserted = server;
                return true;
            }

            @Override
            public List<StoredServer> findAll() {
                return List.of();
            }
        };
        ServerService service = new ServerService(
            repository,
            new ServerStatusClient(new ServerStatusParser(), Duration.ofSeconds(1), new io.micrometer.core.instrument.simple.SimpleMeterRegistry()),
            new ObjectMapper(),
            Duration.ofMinutes(2),
            new io.micrometer.core.instrument.simple.SimpleMeterRegistry()
        );

        service.refreshServers();

        assertEquals("q3.pieter.com", repository.inserted.host());
        assertEquals(443, repository.inserted.proxyPort());
        assertEquals(0, repository.inserted.targetPort());
        assertTrue(repository.inserted.secure());
        assertFalse(repository.inserted.official());
    }

    @Test
    void listsOfficialServersBeforeCommunityServersRegardlessOfPlayerCount() {
        OffsetDateTime now = OffsetDateTime.now();
        List<StoredServer> storedServers = List.of(
            new StoredServer(
                new RegisteredServer("community.example.com", 27961, 27960, true, false, now),
                "{\"sv_hostname\":\"Community\",\"players\":2,\"users\":["
                    + "{\"score\":10,\"ping\":25,\"name\":\"Player One\"},"
                    + "{\"score\":5,\"ping\":30,\"name\":\"Player Two\"}]}",
                now
            ),
            new StoredServer(
                new RegisteredServer("official.example.com", 27961, 27960, true, true, now),
                "{\"sv_hostname\":\"Official\",\"players\":0,\"users\":[]}",
                now
            )
        );
        ServerRepository repository = new ServerRepository(null) {
            @Override
            public List<StoredServer> findAll() {
                return storedServers;
            }
        };
        ServerService service = new ServerService(
            repository,
            new ServerStatusClient(new ServerStatusParser(), Duration.ofSeconds(1), new io.micrometer.core.instrument.simple.SimpleMeterRegistry()),
            new ObjectMapper(),
            Duration.ofMinutes(2),
            new io.micrometer.core.instrument.simple.SimpleMeterRegistry()
        );

        assertEquals(
            List.of("official.example.com", "community.example.com"),
            service.servers().stream().map(server -> server.host()).toList()
        );
    }

    @Test
    void listsOfficialFfaBeforeCtfWhenRealPlayerCountsAreEqual() {
        OffsetDateTime now = OffsetDateTime.now();
        List<StoredServer> storedServers = List.of(
            new StoredServer(
                new RegisteredServer("ctf.example.com", 27961, 27960, true, true, now),
                "{\"sv_hostname\":\"CTF\",\"g_gametype\":4,\"players\":2,\"users\":["
                    + "{\"score\":10,\"ping\":25,\"name\":\"Human\"},"
                    + "{\"score\":5,\"ping\":0,\"name\":\"Bot\"}]}",
                now
            ),
            new StoredServer(
                new RegisteredServer("ffa.example.com", 27961, 27960, true, true, now),
                "{\"sv_hostname\":\"FFA\",\"g_gametype\":0,\"players\":1,\"users\":["
                    + "{\"score\":10,\"ping\":30,\"name\":\"Human\"}]}",
                now
            )
        );
        ServerRepository repository = new ServerRepository(null) {
            @Override
            public List<StoredServer> findAll() {
                return storedServers;
            }
        };
        ServerService service = new ServerService(
            repository,
            new ServerStatusClient(new ServerStatusParser(), Duration.ofSeconds(1), new io.micrometer.core.instrument.simple.SimpleMeterRegistry()),
            new ObjectMapper(),
            Duration.ofMinutes(2),
            new io.micrometer.core.instrument.simple.SimpleMeterRegistry()
        );

        assertEquals(
            List.of("ffa.example.com", "ctf.example.com"),
            service.servers().stream().map(server -> server.host()).toList()
        );
    }
}
