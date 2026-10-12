package com.q3js.master.observability;

import io.micrometer.core.instrument.Meter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Gauge;
import io.agroal.api.AgroalDataSource;
import io.quarkus.runtime.StartupEvent;
import io.micrometer.core.instrument.config.MeterFilter;
import io.micrometer.core.instrument.distribution.DistributionStatisticConfig;
import jakarta.enterprise.inject.Produces;
import jakarta.enterprise.event.Observes;
import jakarta.inject.Singleton;

import java.time.Duration;

@Singleton
public class MetricsConfiguration {
    void poolMetrics(@Observes StartupEvent startup, MeterRegistry metrics, AgroalDataSource dataSource) {
        Gauge.builder("agroal.max.size", dataSource,
            source -> source.getConfiguration().connectionPoolConfiguration().maxSize())
            .tag("datasource", "default").register(metrics);
    }

    @Produces
    @Singleton
    MeterFilter requestHistograms() {
        return new MeterFilter() {
            @Override
            public DistributionStatisticConfig configure(Meter.Id id, DistributionStatisticConfig config) {
                if (id.getName().equals("http.server.requests")) {
                    return DistributionStatisticConfig.builder()
                        .percentilesHistogram(true)
                        .maximumExpectedValue((double) Duration.ofSeconds(10).toNanos())
                        .build().merge(config);
                }
                return config;
            }
        };
    }
}
