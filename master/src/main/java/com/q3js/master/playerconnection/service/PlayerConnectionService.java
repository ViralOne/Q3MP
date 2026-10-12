package com.q3js.master.playerconnection.service;

import com.q3js.master.playerconnection.domain.PlayerConnection;
import com.q3js.master.playerconnection.domain.PlayerAddressPage;
import com.q3js.master.playerconnection.dto.PlayerConnectionRequest;
import com.q3js.master.playerconnection.repository.PlayerConnectionRepository;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.ws.rs.BadRequestException;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import static com.q3js.master.country.service.IpAddressNormalizer.normalize;

@ApplicationScoped
public class PlayerConnectionService {
    private static final Set<String> PRIVATE_KEYS = Set.of("clientip", "ip", "password", "rconpassword");

    private final PlayerConnectionRepository repository;
    private final Counter persistedConnections;

    public PlayerConnectionService(PlayerConnectionRepository repository, MeterRegistry metrics) {
        this.repository = repository;
        persistedConnections = metrics.counter("q3js.player.connections.persisted");
    }

    public void ingest(PlayerConnectionRequest request, String sourceIp) {
        String clientIp = normalize(request.clientIp());
        Map<String, String> userinfo = sanitizedUserinfo(request.userinfo());
        String decodedName = userinfo.entrySet().stream()
            .filter(entry -> entry.getKey().equalsIgnoreCase("name"))
            .map(Map.Entry::getValue)
            .findFirst()
            .orElseThrow(() -> new BadRequestException("Userinfo must contain the player name."));
        if (!decodedName.equals(request.playerName())) {
            throw new BadRequestException("Player name must match userinfo.");
        }

        repository.insert(
            new PlayerConnection(
                clientIp,
                request.playerName(),
                userinfo,
                request.serverHost().trim(),
                request.serverPort()
            ),
            sourceIp
        );
        persistedConnections.increment();
    }

    public PlayerAddressPage addresses(int requestedPage, int pageSize, String search) {
        int totalEntries = repository.count(search);
        int totalPages = Math.max(1, (int) Math.ceil(totalEntries / (double) pageSize));
        int page = Math.min(requestedPage, totalPages);
        int offset = (page - 1) * pageSize;
        return new PlayerAddressPage(
            page,
            pageSize,
            totalEntries,
            totalPages,
            page > 1,
            page < totalPages,
            repository.find(search, pageSize, offset)
        );
    }

    private static Map<String, String> sanitizedUserinfo(Map<String, String> supplied) {
        Map<String, String> sanitized = new LinkedHashMap<>();
        supplied.forEach((key, value) -> {
            if (!PRIVATE_KEYS.contains(key.toLowerCase(Locale.ROOT))) {
                sanitized.put(key, value);
            }
        });
        return Collections.unmodifiableMap(sanitized);
    }
}
