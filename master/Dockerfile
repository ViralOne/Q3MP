FROM maven:3.9.16-eclipse-temurin-17 AS dependencies

WORKDIR /workspace/master

COPY master/pom.xml ./
RUN mvn --batch-mode dependency:go-offline -DskipTests

FROM dependencies AS builder

COPY master/src src
RUN mvn --batch-mode package -DskipTests

FROM eclipse-temurin:17-jre-jammy AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 q3js \
    && useradd --uid 10001 --gid q3js --no-create-home --home-dir /opt/q3js q3js \
    && mkdir -p /state \
    && chown q3js:q3js /state

WORKDIR /opt/q3js/master

COPY --from=builder --chown=q3js:q3js /workspace/master/target/quarkus-app/ ./
COPY --chmod=755 master/docker-entrypoint.sh /usr/local/bin/q3js-master-entrypoint

ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75.0" \
    Q3JS_ADMIN_JWT_PRIVATE_KEY_LOCATION=/state/q3js-admin-private-key.pem \
    Q3JS_ADMIN_JWT_PUBLIC_KEY_LOCATION=/state/q3js-admin-public-key.pem

EXPOSE 8080 9000
VOLUME ["/state"]
USER q3js

ENTRYPOINT ["q3js-master-entrypoint"]
CMD ["java", "-jar", "quarkus-run.jar"]
