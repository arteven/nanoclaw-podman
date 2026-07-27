#!/bin/bash
# Verify this host can run NanoClaw agents under rootless Podman.
#
# Stands up a stand-in OneCLI gateway on host loopback and a host-owned file
# standing in for the session SQLite DB, then A/Bs a container spawned with
# the arguments src/container-runtime.ts generates against one without them.
#
# Expected: the "WITH FIX" block reports ONECLI-GATEWAY-OK and write OK, while
# the baseline block fails both. See docs/podman.md.
set -u
PORT=${NANOCLAW_PROBE_PORT:-18991}

if ! command -v podman >/dev/null 2>&1; then
  echo "podman not found on PATH" >&2
  exit 1
fi
if [ "$(podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null)" != "true" ]; then
  echo "podman is not running rootless — this script probes the rootless path" >&2
  exit 1
fi
WORK=$(mktemp -d /tmp/ncspike-XXXX)
echo "seed" > "$WORK/session.db"
chmod 644 "$WORK/session.db"
echo "host file owner: $(stat -c '%u:%g' "$WORK/session.db")  (host uid=$(id -u))"

python3 -c "
import http.server,socketserver,threading,time
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(s):
        s.send_response(200); s.end_headers(); s.wfile.write(b'ONECLI-GATEWAY-OK')
    def log_message(*a): pass
socketserver.TCPServer.allow_reuse_address=True
srv=socketserver.TCPServer(('127.0.0.1',$PORT),H)
threading.Thread(target=srv.serve_forever,daemon=True).start()
time.sleep(120)
" &
PY=$!
sleep 2

# Ask the real implementation for the runtime args rather than restating them,
# so this probe cannot drift from what container-runtime.ts actually emits.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROBE_TS="$WORK/derive-args.mts"
cat > "$PROBE_TS" <<'PROBE'
const m = await import(process.env.RUNTIME_MODULE!);
process.stdout.write([...m.userNamespaceArgs(), ...m.hostGatewayArgs()].join('\n'));
PROBE
RUNTIME_ARGS=$(
  cd "$REPO_ROOT" && \
  CONTAINER_RUNTIME_BIN=podman ONECLI_URL="http://127.0.0.1:$PORT" \
  RUNTIME_MODULE="$REPO_ROOT/src/container-runtime.ts" \
  npx tsx "$PROBE_TS" 2>/dev/null | grep -E '^--'
)
if [ -z "$RUNTIME_ARGS" ]; then
  echo "could not derive runtime args (is the repo installed? try: pnpm install)" >&2
  kill $PY 2>/dev/null; rm -rf "$WORK"; exit 1
fi
echo "derived runtime args: $(echo "$RUNTIME_ARGS" | tr '\n' ' ')"
mapfile -t DERIVED <<< "$RUNTIME_ARGS"

# Derived args, plus the hardening/user flags container-runner.ts adds.
ARGS=(--rm "${DERIVED[@]}"
      --user "$(id -u):$(id -g)" -e HOME=/home/node
      --cap-drop=ALL --security-opt no-new-privileges --init --shm-size=1g --pids-limit 2048
      -v "$WORK:/workspace")

echo
echo "########## WITH FIX ##########"
timeout 90 podman run "${ARGS[@]}" docker.io/library/alpine:latest sh -c '
  echo "uid inside: $(id -u)"
  echo -n "gateway via host.docker.internal: "; wget -qO- --timeout=5 http://host.docker.internal:'"$PORT"'/ || echo UNREACHABLE
  echo
  echo -n "bind-mount write: "; (echo written > /workspace/session.db && echo OK) 2>&1 || echo "DENIED(readonly db)"
' 2>&1 | tail -6

echo
echo "########## WITHOUT FIX (baseline: no keep-id, no pasta -T) ##########"
timeout 90 podman run --rm --user "$(id -u):$(id -g)" -v "$WORK:/workspace" docker.io/library/alpine:latest sh -c '
  echo -n "gateway via host.docker.internal: "; wget -qO- --timeout=5 http://host.docker.internal:'"$PORT"'/ || echo UNREACHABLE
  echo -n "bind-mount write: "; (echo x > /workspace/session.db && echo OK) 2>&1 || echo "DENIED"
' 2>&1 | tail -4

echo
echo "host sees file as: $(cat $WORK/session.db 2>/dev/null) / owner $(stat -c '%u:%g' $WORK/session.db)"
kill $PY 2>/dev/null; rm -rf "$WORK"
