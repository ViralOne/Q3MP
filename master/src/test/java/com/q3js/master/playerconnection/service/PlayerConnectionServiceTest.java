package com.q3js.master.playerconnection.service;

import com.q3js.master.playerconnection.domain.PlayerConnection;
import com.q3js.master.playerconnection.domain.StoredPlayerAddress;
import com.q3js.master.playerconnection.dto.PlayerConnectionRequest;
import com.q3js.master.playerconnection.repository.PlayerConnectionRepository;

import jakarta.ws.rs.BadRequestException;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class PlayerConnectionServiceTest {
    @Test
    void returnsClampedConnectionPages() {
        var repository = mock(PlayerConnectionRepository.class);
        var service = new PlayerConnectionService(repository, new io.micrometer.core.instrument.simple.SimpleMeterRegistry());
        var entries = List.of(mock(StoredPlayerAddress.class));
        when(repository.count("Ranger")).thenReturn(51);
        when(repository.find("Ranger", 25, 50)).thenReturn(entries);

        var page = service.addresses(99, 25, "Ranger");

        assertEquals(3, page.page());
        assertEquals(25, page.pageSize());
        assertEquals(51, page.totalEntries());
        assertEquals(3, page.totalPages());
        assertTrue(page.hasPreviousPage());
        assertFalse(page.hasNextPage());
        assertEquals(entries, page.entries());
    }

    @Test
    void sanitizesAndStoresDecodedConnections() {
        var repository = mock(PlayerConnectionRepository.class);
        var service = new PlayerConnectionService(repository, new io.micrometer.core.instrument.simple.SimpleMeterRegistry());
        var supplied = new LinkedHashMap<String, String>();
        supplied.put("name", "^1Ranger");
        supplied.put("rate", "25000");
        supplied.put("clientip", "spoofed");
        supplied.put("password", "secret");
        supplied.put("rconPassword", "also-secret");

        service.ingest(
            new PlayerConnectionRequest(
                " 203.0.113.7 ",
                "^1Ranger",
                supplied,
                " game.example.com ",
                27961
            ),
            "10.0.0.1"
        );

        verify(repository).insert(
            new PlayerConnection(
                "203.0.113.7",
                "^1Ranger",
                Map.of("name", "^1Ranger", "rate", "25000"),
                "game.example.com",
                27961
            ),
            "10.0.0.1"
        );
    }

    @Test
    void rejectsANameThatDoesNotMatchUserinfo() {
        var repository = mock(PlayerConnectionRepository.class);
        var service = new PlayerConnectionService(repository, new io.micrometer.core.instrument.simple.SimpleMeterRegistry());
        var request = new PlayerConnectionRequest(
            "203.0.113.7",
            "Ranger",
            Map.of("name", "Sarge"),
            "game.example.com",
            27961
        );

        assertThrows(BadRequestException.class, () -> service.ingest(request, "10.0.0.1"));
        verifyNoInteractions(repository);
    }
}
