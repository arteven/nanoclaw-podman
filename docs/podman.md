# Running NanoClaw on rootless Podman

NanoClaw defaults to Docker. Rootless Podman is supported by setting:

```bash
CONTAINER_RUNTIME_BIN=podman
```

Everything else is detected at runtime — the code probes
`podman info --format '{{.Host.Security.Rootless}}'` once per process and only
then applies the adjustments below. On Docker (or rootful Podman) the
generated `run` arguments are unchanged.

## Installing

Set `CONTAINER_RUNTIME_BIN=podman` in `.env` (or export it) before running
setup, and the install picks Podman up throughout:

```bash
echo 'CONTAINER_RUNTIME_BIN=podman' >> .env
./setup.sh
```

On a host where only Podman is installed, detection finds it without any
configuration. When both runtimes are present Docker still wins by default, so
existing installs keep their current behavior — set the variable to override.

Individual steps take `--runtime podman` as well:

```bash
pnpm exec tsx setup/index.ts --step container --runtime podman
```

Two things setup does differently under rootless Podman:

- `setup/install-docker.sh` is never invoked. Podman is expected to be
  installed already (it is typically distro-packaged); setup will not install a
  container runtime on your behalf.
- The daemon-start and `docker` group recovery paths are skipped. Rootless
  Podman has no daemon and no socket group, so there is nothing to start or
  join — a failure at that point is reported rather than retried.

You need `/etc/subuid` and `/etc/subgid` entries for your user (standard on
distro Podman packages; `podman info` fails without them).

## Verifying your host

```bash
./scripts/verify-podman-runtime.sh
```

This spawns real containers and A/Bs the two failure modes below. Expect
`ONECLI-GATEWAY-OK` and `bind-mount write: OK` in the "WITH FIX" block.

## What differs from Docker, and why

### 1. User namespace — `--userns=keep-id`

Rootless Podman maps container UID 0 to your host user and every other UID
into the unprivileged subuid range (`/etc/subuid`). The agent image runs as
`node` (UID 1000), which therefore maps to a high host UID that does not own
the bind mounts. Symptom: session SQLite writes fail with

```
attempt to write a readonly database
```

`--userns=keep-id` maps the host UID to itself inside the container.

We deliberately do **not** force `--user=0:0` to sidestep this. Running the
agent as root makes Claude Code refuse `--dangerously-skip-permissions`
("cannot be used with root/sudo privileges"), which would cost the permission
bypass the agent loop depends on.

### 2. OneCLI gateway reachability — `pasta:-T`

OneCLI binds host loopback (`ONECLI_URL`, typically `127.0.0.1:<port>`) and the
SDK injects `HTTPS_PROXY=http://host.docker.internal:<port>` into the
container. Podman auto-injects a `host.docker.internal` hosts entry, but it
points at the pasta gateway (`169.254.1.2`) which reaches the host's _external_
interface — not loopback. Symptom: every spawn fails with

```
wget: can't connect to remote host (169.254.1.2): Connection refused
```

Two flags fix this, and both are load-bearing:

- `--network=pasta:-T,<port>` forwards the host loopback port into the
  container, where it appears on the container's own `127.0.0.1`.
- `--add-host=host.docker.internal:127.0.0.1` makes the _name_ the proxy uses
  resolve to that forward.

`-T` alone leaves the hostname pointing at the unreachable gateway; `--add-host`
alone has nothing to point at.

> **Not slirp4netns.** Earlier community patches used
> `slirp4netns:allow_host_loopback=true` with `10.0.2.2`. Podman 5 made pasta
> the default and Podman 6 **removed slirp4netns entirely** — that approach now
> fails with `slirp4netns support has been removed, use --network=pasta instead`.

### 3. Egress lockdown — gateway IP instead of a DNS alias

With `NANOCLAW_EGRESS_LOCKDOWN=true`, agents run on an `--internal` network with
the OneCLI gateway attached under the alias `host.docker.internal`.

Podman's netavark DNS **does not serve those aliases** — it resolves container
_names_ only. This holds whether the alias is set with `--network-alias` at run
time or `network connect --alias` afterwards. The agent would resolve nothing.

Instead we resolve the gateway's address on the egress network host-side and
pin it with `--add-host`, which needs no DNS. If the IP can't be determined we
log a warning rather than failing the spawn: the container still has no route
off the internal network, so it degrades to "gateway unreachable", never to
"open egress".

The rest of egress lockdown works as-is under Podman — `--internal` does block
outbound traffic, and `network inspect --format` parses identically.

### 4. SELinux — `:z` relabeling

On Fedora/RHEL (where Podman is the default runtime) an unlabeled bind mount is
denied inside the container. When `getenforce` reports `Enforcing` or
`Permissive`, mounts get the `:z` shared-category label.

This covers the mounts we build ourselves. The OneCLI SDK also appends mounts of
its own — the CA bundle, the combined cert bundle, and any credential stubs —
using a plain `-v host:container:ro` we don't construct. Left unlabeled, the
container is denied the very certificates it proxies through, so every API call
fails TLS verification. `applySelinuxLabels()` rewrites those specs in the argv
after `applyContainerConfig()` returns, skipping any that already carry `:z`/`:Z`
and doing nothing at all off rootless-Podman-with-SELinux.

## Known gaps

- Only rootless Podman on Linux is exercised. `podman machine` on macOS is
  untested here; the loopback forwarding in particular is likely to differ
  because the gateway lives in the VM.
- Rootful Podman is treated as Docker. That is correct for the mount and
  namespace behavior, but it is not separately tested.
