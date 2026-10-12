package com.q3js.master.server.client;

import com.q3js.master.server.domain.RegisteredServer;
import com.q3js.master.server.service.ServerStatusParser;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.ReadWriteSpan;
import org.junit.jupiter.api.Test;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.Base64;
import java.util.concurrent.CompletableFuture;

import static org.junit.jupiter.api.Assertions.*;

class ServerStatusClientTest {
    @Test
    void recordsSuccessfulAndInvalidWebSocketResponsesWithoutServerLabels() throws Exception {
        for (String payload : new String[]{"ÿÿÿÿstatusResponse\n\\sv_hostname\\Arena\\mapname\\q3dm17\n", "invalid response"}) {
            try (var gateway = new ServerSocket(0); var provider = SdkTracerProvider.builder().build()) {
                var response = CompletableFuture.runAsync(() -> reply(gateway, payload));
                var registry = new SimpleMeterRegistry();
                var client = new ServerStatusClient(new ServerStatusParser(), Duration.ofSeconds(2), registry);
                var span = provider.get("test").spanBuilder("status").startSpan();
                boolean valid = payload.contains("statusResponse");
                try (var scope = span.makeCurrent()) {
                    assertEquals(valid, client.query(server(gateway.getLocalPort())).isPresent());
                }
                span.end();
                assertEquals(valid ? StatusCode.UNSET : StatusCode.ERROR, ((ReadWriteSpan) span).toSpanData().getStatus().getStatusCode());
                assertEquals(1, registry.get("q3js.server.status.query").tag("outcome", valid ? "success" : "failure").timer().count());
                assertTrue(registry.getMeters().stream().allMatch(m -> m.getId().getTags().size() == 1));
                response.get();
            }
        }
    }

    @Test
    void recordsConnectionFailure() throws Exception {
        int port;
        try (var gateway = new ServerSocket(0)) { port = gateway.getLocalPort(); }
        var registry = new SimpleMeterRegistry();
        var client = new ServerStatusClient(new ServerStatusParser(), Duration.ofMillis(100), registry);
        assertTrue(client.query(server(port)).isEmpty());
        assertEquals(1, registry.get("q3js.server.status.query").tag("outcome", "failure").timer().count());
    }

    private static RegisteredServer server(int port) {
        return new RegisteredServer("localhost", port, 27960, false, false, OffsetDateTime.now());
    }

    private static void reply(ServerSocket gateway, String payload) {
        try (var socket = gateway.accept()) {
            socket.setSoTimeout(3000);
            var reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
            String key = null;
            for (String line; !(line = reader.readLine()).isEmpty();) {
                if (line.toLowerCase().startsWith("sec-websocket-key:")) { key = line.substring(line.indexOf(':') + 1).trim(); }
            }
            String accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1")
                .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII)));
            var output = socket.getOutputStream();
            output.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            output.flush();
            var input = socket.getInputStream();
            input.read();
            int length = input.read() & 127;
            input.readNBytes(4 + length);
            byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
            output.write(0x81);
            output.write(bytes.length);
            output.write(bytes);
            output.flush();
        } catch (Exception exception) { throw new RuntimeException(exception); }
    }
}
