#!/bin/bash
set +x
set -euo pipefail
export LC_ALL=C
step='Checking installation requirements'
enrolled=no
work=''
log=''
reason=''
resume=no
exec 3>&1 4>&2
progress() { printf '%s\n' "$*" >&3; }
finish() {
  status=$?
  trap - EXIT
  if [ -n "$work" ]; then rm -rf -- "$work"; fi
  if [ "$status" -ne 0 ]; then
    if [ -n "$log" ]; then
      while IFS= read -r line; do
        case "$line" in
          '[ERROR] '*) reason=${line#'[ERROR] '} ;;
          '') ;;
          *) if [ -z "$reason" ]; then fallback=$line; else reason+=$'\n'"$line"; fi ;;
        esac
      done < "$log"
    fi
    printf '\nFAILED: %s\n%s\n' "$step" "${reason:-${fallback:-Installation could not continue.}}" >&4
    if [ "$enrolled" = yes ]; then
      printf 'Machine identity retained. Fix the cause above, then resume from this package directory:\n  sudo bash ./install.sh --resume\n' >&4
      printf 'Configuration: /etc/allocube-terminal/config.json\n' >&4
    else
      printf 'Next: fix the cause above, then rerun the enrollment command from Allocube.\n' >&4
    fi
    if [ -n "$log" ]; then printf 'Details: sudo cat %s\n' "$log" >&4; fi
  fi
  exit "$status"
}
trap finish EXIT
package_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
if [ "$#" -eq 1 ] && [ "$1" = --resume ]; then resume=yes
elif [ "$#" -ne 0 ]; then reason='Usage: bash ./install.sh [--resume]'; exit 1; fi
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null || { reason='Run this script as root or install sudo.'; exit 1; }
  exec sudo --preserve-env=ALLOCUBE_PLATFORM,ALLOCUBE_TERMINAL_ID,ALLOCUBE_ENROLL_TOKEN,ALLOCUBE_CA_CERT,ALLOCUBE_CONFIGURE_SSH /bin/bash "$package_dir/install.sh" "$@"
fi
[ "$(uname -s)/$(uname -m)" = 'Linux/__MACHINE__' ] || { reason='Wrong OS or architecture. Download the matching Linux package from Allocube.'; exit 1; }
for tool in mktemp sha256sum install mv base64 flock; do
  command -v "$tool" >/dev/null || { reason="Missing dependency: $tool. Install it, then retry."; exit 1; }
done
if [ "$resume" = no ]; then
for variable in ALLOCUBE_PLATFORM ALLOCUBE_TERMINAL_ID ALLOCUBE_ENROLL_TOKEN; do
  [ -n "${!variable:-}" ] || { reason="Missing $variable. Copy the enrollment command from Allocube, or use --resume for a registered machine."; exit 1; }
done
platform=$ALLOCUBE_PLATFORM
terminal_id=$ALLOCUBE_TERMINAL_ID
enrollment_token=$ALLOCUBE_ENROLL_TOKEN
else
platform=''; terminal_id=''; enrollment_token=''
fi
certificate=${ALLOCUBE_CA_CERT:-}
ssh_mode=${ALLOCUBE_CONFIGURE_SSH:-ask}
unset ALLOCUBE_ENROLL_TOKEN ALLOCUBE_CA_CERT
if [ "$resume" = no ]; then
[[ "$platform" =~ ^https://[^/[:space:]]+$ && "$terminal_id" =~ ^[a-f0-9-]{36}$ && "$enrollment_token" =~ ^[A-Za-z0-9_-]{32,128}$ ]] || { reason='Invalid enrollment parameters.'; exit 1; }
fi
[[ "$ssh_mode" = ask || "$ssh_mode" = skip ]] || { reason='ALLOCUBE_CONFIGURE_SSH must be ask or skip.'; exit 1; }
exec 9>/run/allocube-terminal-install.lock
flock -n 9 || { reason='Another deployment is running. Wait for it to finish.'; exit 1; }
work=$(mktemp -d)
install -d -o root -g root -m 0755 /var/log
log=$(mktemp /var/log/allocube-terminal-install.XXXXXX.log)
exec >>"$log" 2>&1
progress 'Installing Allocube public key sync...'
# Verify a private snapshot, so extracted files cannot change between checking
# their hashes and copying them into the installation directory.
for file in allocube-terminal install.sh SHA256SUMS; do
  install -m 0644 "$package_dir/$file" "$work/$file"
done
(cd "$work" && sha256sum --status -c SHA256SUMS) || { echo '[ERROR] Package checksum verification failed. Download and extract a fresh deployment package.' >&2; exit 1; }
echo '[OK] Package verified.'
step='Installing the program and registering this machine (step 2/5)'
binary=/usr/local/bin/allocube-terminal
install -o root -g root -m 0755 "$work/allocube-terminal" /usr/local/bin/.allocube-terminal-new
mv -f /usr/local/bin/.allocube-terminal-new "$binary"
ca_args=()
if [ -n "$certificate" ]; then
  [ ! -L /etc/allocube-terminal ] || { echo 'Unsafe configuration directory.' >&2; exit 1; }
  printf '%s' "$certificate" | base64 -d > "$work/platform-ca.pem"
  fingerprint=$(sha256sum "$work/platform-ca.pem"); fingerprint=${fingerprint%% *}
  ca_file="/etc/allocube-terminal/platform-ca-$fingerprint.pem"
  install -d -o root -g root -m 0755 /etc/allocube-terminal
  install -o root -g root -m 0644 "$work/platform-ca.pem" "$ca_file.new"
  mv -f "$ca_file.new" "$ca_file"
  ca_args=(--ca-file "$ca_file")
fi
if [ "$resume" = yes ]; then
  step='Checking saved registration'
  if [ -f /etc/allocube-terminal/config.json ]; then enrolled=yes; fi
  "$binary" verify-registration
else
  printf '%s\n' "$platform" "$terminal_id" "$enrollment_token" | "$binary" "${ca_args[@]}" setup
fi
unset enrollment_token certificate
enrolled=yes
echo '[OK] Machine registration is ready.'
step='Preparing SSH access'
echo '[INFO] Local account -> Allocube employee mapping:'
"$binary" mappings
if [ "$ssh_mode" = ask ]; then
  "$binary" --verbose configure-ssh
else
  echo '[SKIP] Automatic SSH configuration was disabled by ALLOCUBE_CONFIGURE_SSH=skip.'
fi
step='Installing the sync timer'
"$binary" install
step='Running the final key sync'
"$binary" sync
"$binary" status > "$work/summary"
progress 'INSTALLED'
while IFS= read -r line; do progress "$line"; done < "$work/summary"
progress "Details: sudo cat $log"
exit 0
