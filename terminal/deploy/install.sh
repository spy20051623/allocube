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
reenroll=no
upgrading=no
timer_stopped=no
backup=''
candidate=''
exec 3>&1 4>&2
progress() { printf '%s\n' "$*" >&3; }
finish() {
  status=$?
  trap - EXIT
  if [ -n "$work" ]; then rm -rf -- "$work"; fi
  if [ -n "$candidate" ]; then rm -f -- "$candidate"; fi
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
      if [ "$reenroll" = yes ]; then
        printf 'Machine identity retained. Fix the cause above, then rerun the enrollment command with --reenroll.\n' >&4
      else
        printf 'Machine identity retained. Fix the cause above, then rerun from this package directory:\n  sudo bash ./install.sh\n' >&4
      fi
      printf 'Configuration: /etc/allocube-terminal/config.json\n' >&4
    else
      printf 'Next: fix the cause above, then rerun the enrollment command from Allocube.\n' >&4
    fi
    if [ -n "$log" ]; then printf 'Details: sudo cat %s\n' "$log" >&4; fi
    if [ "$timer_stopped" = yes ]; then printf 'Scheduled sync remains stopped until installation succeeds.\n' >&4; fi
    if [ -n "$backup" ]; then printf 'Previous program, configuration and service files: %s\n' "$backup" >&4; fi
  fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
package_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
if [ "$#" -eq 1 ] && [ "$1" = --resume ]; then resume=yes
elif [ "$#" -eq 1 ] && [ "$1" = --reenroll ]; then reenroll=yes
elif [ "$#" -ne 0 ]; then reason='Usage: bash ./install.sh [--resume|--reenroll]'; exit 1; fi
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null || { reason='Run this script as root or install sudo.'; exit 1; }
  exec sudo --preserve-env=ALLOCUBE_PLATFORM,ALLOCUBE_TERMINAL_ID,ALLOCUBE_ENROLL_TOKEN,ALLOCUBE_CA_CERT,ALLOCUBE_CONFIGURE_SSH /bin/bash "$package_dir/install.sh" "$@"
fi
[ "$(uname -s)/$(uname -m)" = 'Linux/__MACHINE__' ] || { reason='Wrong OS or architecture. Download the matching Linux package from Allocube.'; exit 1; }
for tool in mktemp sha256sum install mv base64 flock systemctl cp sleep; do
  command -v "$tool" >/dev/null || { reason="Missing dependency: $tool. Install it, then retry."; exit 1; }
done
# An existing identity selects upgrade, even if an old enrollment command was
# pasted again. Only an explicit --reenroll may replace the saved registration.
exec 9>/run/allocube-terminal-install.lock
flock -n 9 || { reason='Another deployment is running. Wait for it to finish.'; exit 1; }
if [ -e /etc/allocube-terminal/config.json ] || [ -L /etc/allocube-terminal/config.json ]; then
  upgrading=yes
  enrolled=yes
  if [ "$reenroll" = no ]; then resume=yes; fi
elif [ "$resume" = yes ]; then
  reason='Saved configuration is missing: /etc/allocube-terminal/config.json. Restore it before retrying.'; exit 1
elif [ -e /etc/allocube-terminal/identity.key ] || [ -L /etc/allocube-terminal/identity.key ]; then
  reason='A machine identity exists without /etc/allocube-terminal/config.json. Restore the configuration before retrying; do not delete the identity key.'; exit 1
else
  service_state=$(systemctl show --property=LoadState --value allocube-terminal-sync.service)
  if [ "$service_state" != not-found ] && [ -n "$service_state" ]; then
    reason='An existing sync service has no configuration at /etc/allocube-terminal/config.json. Restore its configuration before upgrading; it will not be overwritten.'; exit 1
  fi
fi
if [ "$resume" = no ]; then
for variable in ALLOCUBE_PLATFORM ALLOCUBE_TERMINAL_ID ALLOCUBE_ENROLL_TOKEN; do
  [ -n "${!variable:-}" ] || { reason="Missing $variable. Copy the enrollment command from Allocube for first-time installation."; exit 1; }
done
platform=$ALLOCUBE_PLATFORM
terminal_id=$ALLOCUBE_TERMINAL_ID
enrollment_token=$ALLOCUBE_ENROLL_TOKEN
else
platform=''; terminal_id=''; enrollment_token=''
fi
certificate=''
if [ "$resume" = no ]; then certificate=${ALLOCUBE_CA_CERT:-}; fi
ssh_mode=${ALLOCUBE_CONFIGURE_SSH:-ask}
unset ALLOCUBE_ENROLL_TOKEN ALLOCUBE_CA_CERT
if [ "$resume" = no ]; then
[[ "$platform" =~ ^https://[^/[:space:]]+$ && "$terminal_id" =~ ^[a-f0-9-]{36}$ && "$enrollment_token" =~ ^[A-Za-z0-9_-]{32,128}$ ]] || { reason='Invalid enrollment parameters.'; exit 1; }
fi
[[ "$ssh_mode" = ask || "$ssh_mode" = skip ]] || { reason='ALLOCUBE_CONFIGURE_SSH must be ask or skip.'; exit 1; }
work=$(mktemp -d)
install -d -o root -g root -m 0755 /var/log
log=$(mktemp /var/log/allocube-terminal-install.XXXXXX.log)
exec >>"$log" 2>&1
if [ "$upgrading" = yes ]; then progress 'Upgrading Allocube public key sync...'
else progress 'Installing Allocube public key sync...'; fi
# Verify a private snapshot, so extracted files cannot change between checking
# their hashes and copying them into the installation directory.
for file in allocube-terminal install.sh SHA256SUMS; do
  install -m 0644 "$package_dir/$file" "$work/$file"
done
(cd "$work" && sha256sum --status -c SHA256SUMS) || { echo '[ERROR] Package checksum verification failed. Download and extract a fresh deployment package.' >&2; exit 1; }
echo '[OK] Package verified.'
# Validate saved identity with the new binary before replacing the running
# installation or stopping its timer. Failed authentication must not re-enroll.
install -d -o root -g root -m 0755 /usr/local/bin
candidate=$(mktemp /usr/local/bin/.allocube-terminal-upgrade.XXXXXX)
install -o root -g root -m 0755 "$work/allocube-terminal" "$candidate"
if [ "$resume" = yes ]; then
  step='Checking saved registration'
  "$candidate" verify-registration
fi
step='Waiting for current synchronization'
timer_state=$(systemctl show --property=LoadState --value allocube-terminal-sync.timer)
if [ "$timer_state" != not-found ] && [ -n "$timer_state" ]; then
  systemctl stop allocube-terminal-sync.timer
  timer_stopped=yes
fi
# Never stop/kill the oneshot service in the middle of an SSH transaction.
deadline=$((SECONDS + 150))
waiting=no
while :; do
  service_state=$(systemctl show --property=ActiveState --value allocube-terminal-sync.service)
  case "$service_state" in
    activating|active|deactivating|reloading)
      if [ "$waiting" = no ]; then progress 'Waiting for the current sync to finish...'; waiting=yes; fi
      [ "$SECONDS" -lt "$deadline" ] || { echo '[ERROR] Current sync has not finished after 150 seconds. It was not interrupted. Wait for it to finish, then rerun this installer.' >&2; exit 1; }
      sleep 1 ;;
    inactive|failed|'') break ;;
    *) echo '[ERROR] Cannot determine the sync service state; no program files replaced.' >&2; exit 1 ;;
  esac
done
if [ "$upgrading" = yes ]; then
  step='Saving the previous installation'
  install -d -o root -g root -m 0700 /var/backups/allocube-terminal
  backup=$(mktemp -d /var/backups/allocube-terminal/upgrade.XXXXXX)
  for saved in /etc/allocube-terminal /usr/local/bin/allocube-terminal /etc/systemd/system/allocube-terminal-sync.service /etc/systemd/system/allocube-terminal-sync.timer /etc/systemd/system/allocube-terminal-sync.service.d /etc/systemd/system/allocube-terminal-sync.timer.d; do
    if [ -e "$saved" ] || [ -L "$saved" ]; then cp -a --parents -- "$saved" "$backup/"; fi
  done
fi
step='Installing the program and registering this machine (step 2/5)'
binary=/usr/local/bin/allocube-terminal
mv -f "$candidate" "$binary"
candidate=''
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
  echo '[OK] Reusing saved registration, account mappings and exclusions.'
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
"$binary" --defer-timer-start install
step='Running the final key sync'
"$binary" sync
step='Starting the sync timer'
"$binary" start-timer
timer_stopped=no
"$binary" status > "$work/summary"
if [ "$upgrading" = yes ]; then progress 'UPGRADED'; else progress 'INSTALLED'; fi
while IFS= read -r line; do progress "$line"; done < "$work/summary"
progress "Details: sudo cat $log"
if [ -n "$backup" ]; then progress "Previous installation: $backup"; fi
exit 0
