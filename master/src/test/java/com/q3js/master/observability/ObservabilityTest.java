package com.q3js.master.observability;

import com.q3js.master.event.domain.IngestedEvent;
import com.q3js.master.event.dto.EventRequest;
import com.q3js.master.event.repository.EventRepository;
import com.q3js.master.event.service.EventService;
import com.q3js.master.playerconnection.dto.PlayerConnectionRequest;
import com.q3js.master.playerconnection.repository.PlayerConnectionRepository;
import com.q3js.master.playerconnection.service.PlayerConnectionService;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import io.quarkus.test.junit.QuarkusTest;
import io.quarkus.test.common.http.TestHTTPResource;
import org.junit.jupiter.api.Test;

import java.net.URL;
import java.util.Map;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.containsString;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@QuarkusTest
class ObservabilityTest {
    @TestHTTPResource(value = "/metrics", management = true)
    URL metricsUrl;

    @Test
    void metricsArePrivateAndExistingEndpointsStayOnTheApplicationPort() {
        given().get("/q/metrics").then().statusCode(404);
        given().get(metricsUrl).then().statusCode(200).body(containsString("jvm_memory_used_bytes"));
        given().get("/q/health").then().statusCode(200);
        given().get("/q/openapi").then().statusCode(200);
        given().get("/q/swagger-ui/").then().statusCode(200);
        given().get("/api/status").then().statusCode(200);
    }

    @Test
    void countersOnlyIncludePersistedEventsAndUseBoundedTypes() {
        var registry = new SimpleMeterRegistry();
        var repository = mock(EventRepository.class);
        var service = new EventService(repository, registry);
        var request = new EventRequest(" JOIN ", new EventRequest.EventPlayer(1, "private-player"),
            null, null, null, 1, 1, "private-map");
        service.ingest(request, "203.0.113.7");
        assertEquals(1, registry.get("q3js.events.persisted").tag("type", "join").counter().count());
        doThrow(new IllegalStateException("database unavailable")).when(repository).insert(any(IngestedEvent.class), any());
        assertThrows(IllegalStateException.class, () -> service.ingest(request, "203.0.113.7"));
        assertEquals(1, registry.get("q3js.events.persisted").counter().count());
        assertEquals(1, registry.getMeters().size());
        assertEquals("type", registry.getMeters().get(0).getId().getTags().get(0).getKey());
    }

    @Test
    void connectionCounterDoesNotCountFailedPersistenceOrValidation() {
        var registry = new SimpleMeterRegistry();
        var repository = mock(PlayerConnectionRepository.class);
        var service = new PlayerConnectionService(repository, registry);
        var request = new PlayerConnectionRequest("203.0.113.7", "private-player",
            Map.of("name", "private-player"), "private-host", 27961);
        service.ingest(request, null);
        doThrow(new IllegalStateException("database unavailable")).when(repository).insert(any(), any());
        assertThrows(IllegalStateException.class, () -> service.ingest(request, null));
        assertEquals(1, registry.get("q3js.player.connections.persisted").counter().count());
        assertTrue(registry.getMeters().get(0).getId().getTags().isEmpty());
    }
}
