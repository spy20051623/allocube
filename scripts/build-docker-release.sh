#!/bin/sh
set -eu

release_id=${1:?"usage: build-docker-release.sh <release-id> [build-context]"}
build_context=${2:-.}
image_repository=${ALLOCUBE_IMAGE_REPOSITORY:-allocube}
cache_repository=${ALLOCUBE_BUILD_CACHE_REPOSITORY:-allocube-build-cache}
cache_directory=${ALLOCUBE_BUILD_CACHE_DIR:-/opt/allocube-build-cache}
base_image=${ALLOCUBE_BASE_IMAGE:-node:22-bookworm-slim}
debian_mirror=${DEBIAN_MIRROR:-http://mirrors.aliyun.com/debian}
debian_security_mirror=${DEBIAN_SECURITY_MIRROR:-http://mirrors.aliyun.com/debian-security}

for dependency_input in package.json package-lock.json Dockerfile; do
  if [ ! -f "$build_context/$dependency_input" ]; then
    echo "missing $dependency_input in build context: $build_context" >&2
    exit 1
  fi
done

lock_hash=$(sha256sum "$build_context/package-lock.json" | awk '{print substr($1, 1, 16)}')
dependency_hash=$(
  {
    for dependency_input in package.json package-lock.json Dockerfile; do
      sha256sum "$build_context/$dependency_input" | awk '{print $1}'
    done
    printf '%s\n' "$base_image" "$debian_mirror" "$debian_security_mirror"
  } | sha256sum | awk '{print substr($1, 1, 16)}'
)
current_cache="$cache_repository:current"
dependency_cache="$cache_repository:deps-$dependency_hash"
release_cache="$cache_repository:$release_id"
cache_archive="$cache_directory/deps-$dependency_hash.tar"
cache_archive_manifest="$cache_archive.manifest"
legacy_cache="$cache_repository:lock-$lock_hash"
legacy_archive="$cache_directory/lock-$lock_hash.tar"

mkdir -p "$cache_directory"

refresh_archive=0
if ! docker image inspect "$dependency_cache" >/dev/null 2>&1 \
  || ! docker image inspect "$base_image" >/dev/null 2>&1; then
  if [ -f "$cache_archive" ]; then
    echo "restoring dependency cache from $cache_archive"
    if ! docker load --input "$cache_archive"; then
      echo "stored dependency cache is unreadable; rebuilding it" >&2
      refresh_archive=1
    fi
  fi
fi

cache_hit=0
if docker image inspect "$dependency_cache" >/dev/null 2>&1 \
  && docker image inspect "$base_image" >/dev/null 2>&1; then
  cache_hit=1
  docker tag "$dependency_cache" "$current_cache"
fi

if [ "$cache_hit" = "0" ] \
  && ! docker image inspect "$current_cache" >/dev/null 2>&1; then
  if ! docker image inspect "$legacy_cache" >/dev/null 2>&1 \
    && [ -f "$legacy_archive" ]; then
    echo "restoring legacy dependency cache from $legacy_archive"
    docker load --input "$legacy_archive" || true
  fi
  if docker image inspect "$legacy_cache" >/dev/null 2>&1; then
    docker tag "$legacy_cache" "$current_cache"
  fi
fi

cache_arguments=""
if [ "$cache_hit" = "1" ]; then
  cache_arguments="--cache-from=$dependency_cache"
elif docker image inspect "$current_cache" >/dev/null 2>&1; then
  cache_arguments="--cache-from=$current_cache"
fi

if [ "$cache_hit" = "1" ]; then
  echo "dependency cache hit: $cache_archive"
  docker build --pull=false --network=none \
    $cache_arguments \
    --build-arg "DEBIAN_MIRROR=$debian_mirror" \
    --build-arg "DEBIAN_SECURITY_MIRROR=$debian_security_mirror" \
    --target build \
    --tag "$release_cache" \
    "$build_context"
else
  echo "dependency cache miss: downloading missing dependencies and saving $cache_archive"
  docker build --pull=false \
    $cache_arguments \
    --build-arg "DEBIAN_MIRROR=$debian_mirror" \
    --build-arg "DEBIAN_SECURITY_MIRROR=$debian_security_mirror" \
    --target build \
    --tag "$release_cache" \
    "$build_context"
fi

docker tag "$release_cache" "$current_cache"
docker tag "$release_cache" "$dependency_cache"

archive_manifest=$(printf '%s\n%s\n' \
  "$dependency_cache=$(docker image inspect "$dependency_cache" --format '{{.Id}}')" \
  "$base_image=$(docker image inspect "$base_image" --format '{{.Id}}')")
stored_archive_manifest=""
if [ -f "$cache_archive_manifest" ]; then
  stored_archive_manifest=$(cat "$cache_archive_manifest")
fi

if [ "$refresh_archive" = "1" ] || [ ! -f "$cache_archive" ] \
  || [ "$stored_archive_manifest" != "$archive_manifest" ]; then
  temporary_archive="$cache_archive.tmp"
  temporary_manifest="$cache_archive_manifest.tmp"
  docker save --output "$temporary_archive" "$dependency_cache" "$base_image"
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

echo "built $image_repository:$release_id with dependency cache $dependency_cache"
