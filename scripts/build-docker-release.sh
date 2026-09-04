#!/bin/sh
set -eu

release_id=${1:?"usage: build-docker-release.sh <release-id> [build-context]"}
build_context=${2:-.}
image_repository=${ALLOCUBE_IMAGE_REPOSITORY:-allocube}
cache_repository=${ALLOCUBE_BUILD_CACHE_REPOSITORY:-allocube-build-cache}
cache_directory=${ALLOCUBE_BUILD_CACHE_DIR:-/opt/allocube-build-cache}
base_image=${ALLOCUBE_BASE_IMAGE:-node:22-bookworm-slim}
allow_download=${ALLOCUBE_ALLOW_DEPENDENCY_DOWNLOAD:-0}
debian_mirror=${DEBIAN_MIRROR:-http://mirrors.aliyun.com/debian}
debian_security_mirror=${DEBIAN_SECURITY_MIRROR:-http://mirrors.aliyun.com/debian-security}

if [ ! -f "$build_context/package-lock.json" ]; then
  echo "missing package-lock.json in build context: $build_context" >&2
  exit 1
fi

lock_hash=$(sha256sum "$build_context/package-lock.json" | awk '{print substr($1, 1, 16)}')
current_cache="$cache_repository:current"
lock_cache="$cache_repository:lock-$lock_hash"
release_cache="$cache_repository:$release_id"
cache_archive="$cache_directory/lock-$lock_hash.tar"
cache_archive_manifest="$cache_archive.manifest"

mkdir -p "$cache_directory"

if ! docker image inspect "$current_cache" >/dev/null 2>&1 \
  || ! docker image inspect "$base_image" >/dev/null 2>&1; then
  if [ -f "$cache_archive" ]; then
    echo "restoring dependency cache from $cache_archive"
    docker load --input "$cache_archive"
  fi
fi

if ! docker image inspect "$current_cache" >/dev/null 2>&1; then
  if docker image inspect "$lock_cache" >/dev/null 2>&1; then
    docker tag "$lock_cache" "$current_cache"
  elif [ "$allow_download" != "1" ]; then
    echo "dependency cache is unavailable; refusing to download packages" >&2
    echo "set ALLOCUBE_ALLOW_DEPENDENCY_DOWNLOAD=1 only when dependencies intentionally change" >&2
    exit 1
  fi
fi

if [ "$allow_download" != "1" ] \
  && ! docker image inspect "$base_image" >/dev/null 2>&1; then
  echo "base image $base_image is unavailable; refusing to download it" >&2
  echo "restore $cache_archive or set ALLOCUBE_ALLOW_DEPENDENCY_DOWNLOAD=1 intentionally" >&2
  exit 1
fi

cache_arguments=""
if docker image inspect "$current_cache" >/dev/null 2>&1; then
  cache_arguments="--cache-from=$current_cache"
fi

if [ "$allow_download" = "1" ]; then
  docker build --pull=false \
    $cache_arguments \
    --build-arg "DEBIAN_MIRROR=$debian_mirror" \
    --build-arg "DEBIAN_SECURITY_MIRROR=$debian_security_mirror" \
    --target build \
    --tag "$release_cache" \
    "$build_context"
else
  docker build --pull=false --network=none \
    $cache_arguments \
    --build-arg "DEBIAN_MIRROR=$debian_mirror" \
    --build-arg "DEBIAN_SECURITY_MIRROR=$debian_security_mirror" \
    --target build \
    --tag "$release_cache" \
    "$build_context"
fi

docker tag "$release_cache" "$current_cache"
docker tag "$release_cache" "$lock_cache"

archive_manifest=$(printf '%s\n%s\n' \
  "$lock_cache=$(docker image inspect "$lock_cache" --format '{{.Id}}')" \
  "$base_image=$(docker image inspect "$base_image" --format '{{.Id}}')")
stored_archive_manifest=""
if [ -f "$cache_archive_manifest" ]; then
  stored_archive_manifest=$(cat "$cache_archive_manifest")
fi

if [ ! -f "$cache_archive" ] || [ "$stored_archive_manifest" != "$archive_manifest" ]; then
  temporary_archive="$cache_archive.tmp"
  temporary_manifest="$cache_archive_manifest.tmp"
  docker save --output "$temporary_archive" "$lock_cache" "$base_image"
  printf '%s\n' "$archive_manifest" >"$temporary_manifest"
  mv "$temporary_archive" "$cache_archive"
  mv "$temporary_manifest" "$cache_archive_manifest"
fi

docker build --pull=false --network=none \
  --cache-from "$release_cache" \
  --build-arg "DEBIAN_MIRROR=$debian_mirror" \
  --build-arg "DEBIAN_SECURITY_MIRROR=$debian_security_mirror" \
  --tag "$image_repository:$release_id" \
  "$build_context"

echo "built $image_repository:$release_id with dependency cache $lock_cache"
