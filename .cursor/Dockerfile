FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      git-lfs \
      build-essential \
      python3 \
      python3-pip \
      python3-venv \
      ffmpeg \
      blender \
    && rm -rf /var/lib/apt/lists/* \
    && git lfs install --system

# Node.js 22 LTS (Director recommendation)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

USER ubuntu
