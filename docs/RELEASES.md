# Releases

Every egg release pins both forms of the same build. Eggs and nests verify by digest / sha256, so mirrors are safe.

| Release | Image (pin by digest) | Bundle (Docker-less hosts) |
|---|---|---|
| [egg-v0.1.1](https://github.com/dominant-strategies/gremlinz/releases/tag/egg-v0.1.1) (2026-11-04) | `ghcr.io/dominant-strategies/gremlinz-egg@sha256:ab5a7e467835991b4f7c93581028d08ff46142dffb9f6045a2ee35519acd9831` | [`gremlin-linux-amd64.tgz`](https://github.com/dominant-strategies/gremlinz/releases/download/egg-v0.1.1/gremlin-linux-amd64.tgz) sha256 `0804cffc24b011b5c391dff15c384ae9f96935800d273102ce79ecde579b15c2` |
| [egg-v0.1.0](https://github.com/dominant-strategies/gremlinz/releases/tag/egg-v0.1.0) (2026-10-08) | `ghcr.io/dominant-strategies/gremlinz-egg@sha256:364ec160e46c1c6b3ee0b46eeb58c202cbea214218fe7b3da25308a87e441936` | [`gremlin-linux-amd64.tgz`](https://github.com/dominant-strategies/gremlinz/releases/download/egg-v0.1.0/gremlin-linux-amd64.tgz) sha256 `b6ef6ecb7d846614ecb986a60f75e054acb01909ff0a86bf9d8856a6aaa4fe23` |

egg-v0.1.1 fixes CVE-2026-111497 (Node2Shell: Brotli decoder out-of-bounds write) with Node 24.22.1; egg-v0.1.0 runs an
unpatched Node 22 and must not be used for new eggs.

## Publishing a release

1. `docker buildx build --platform linux/amd64 -f egg.Dockerfile -t ghcr.io/dominant-strategies/gremlinz-egg:<commit> --push .` and note the manifest digest.
2. Extract the bundle from that exact image:
   `docker run --rm --platform linux/amd64 --entrypoint tar <image@digest> -czf - -C /app . > release/gremlin-linux-amd64.tgz`, then `shasum -a 256`.
3. `gh release create egg-vX.Y.Z release/gremlin-linux-amd64.tgz release/gremlin-linux-amd64.tgz.sha256 …`
4. Build the site with `VITE_EGG_IMAGE=<image@digest> VITE_EGG_ARTIFACT_URL=<bundle url> VITE_EGG_ARTIFACT_SHA256=<sha256>`
   (see `scripts/deploy-site.sh`).

The ghcr.io package must be **public** (Package settings → Change visibility) so egg servers can pull anonymously.
