FROM buildpack-deps:bookworm-scm AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential cmake ninja-build zip bzip2 libcurl4-openssl-dev \
  && rm -rf /var/lib/apt/lists/*

COPY game/engine /src/engine
WORKDIR /src/build
RUN cmake -S /src/engine -B . -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_CLIENT=OFF \
      -DBUILD_SERVER=ON \
      -DBUILD_GAME_LIBRARIES=OFF \
      -DBUILD_GAME_QVMS=ON \
      -DBUILD_RENDERER_GL1=OFF \
      -DBUILD_RENDERER_GL2=OFF \
      -DUSE_OPENAL=OFF \
      -DUSE_VOIP=OFF \
  && cmake --build . --parallel "$(nproc)"

# Package the compiled QVMs (cgame/qagame/ui) as a small pk3. Quake 3 refuses
# archive entries whose timestamps look like they were written in the future,
# so clamp them to a stable epoch first.
RUN mkdir -p /stage/vm \
  && QVM_CGAME=$(find . -name cgame.qvm | head -1) \
  && QVM_QAGAME=$(find . -name qagame.qvm | head -1) \
  && QVM_UI=$(find . -name ui.qvm | head -1) \
  && cp "$QVM_CGAME" "$QVM_QAGAME" "$QVM_UI" /stage/vm/ \
  && cd /stage \
  && touch -t 200001010000 vm/*.qvm \
  && zip -q -9 -X /zz-webvm.pk3 vm/cgame.qvm vm/qagame.qvm vm/ui.qvm \
  && zip -q -9 -X /zz-scorekeep.pk3 vm/qagame.qvm

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libcurl4 && rm -rf /var/lib/apt/lists/*
# copy everything we need: the dedicated server binary, the QVM pk3s, and the
# script that stages the game directory at startup
COPY --from=build /src/build/Release/ioq3ded /usr/local/bin/ioq3ded
COPY --from=build /zz-webvm.pk3 /opt/baseq3-extra/zz-webvm.pk3
# zz-scorekeep contains ONLY qagame.qvm: the game module with reconnect-score
# preservation. Server-side only — clients keep the vanilla cgame/ui from the
# official paks (the fork's ui.qvm needs menu data files we cannot ship).
COPY --from=build /zz-scorekeep.pk3 /opt/baseq3-extra/zz-scorekeep.pk3
COPY deploy/server/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY deploy/server/defaults/baseq3.cfg deploy/server/defaults/demoq3.cfg /defaults/
RUN chmod +x /usr/local/bin/entrypoint.sh

# /game is the writable fs_basepath where the entrypoint stages:
#   /game/baseq3/zz-webvm.pk3        (copied from image)
#   /game/baseq3/*.pk3 -> symlink into the mounted Quake 3 data
#   /game/baseq3/fs_game or /game/<fs_game> for config (optional volume)
ENV FS_BASEPATH=/game \
    FS_HOMEPATH=/state
VOLUME /state

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
