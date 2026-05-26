# Aside deploy assets

Two files matter for "users see a friendly page during deploys, not raw nginx 502":

| File | What it is | Where it lives in prod |
|---|---|---|
| `maintenance.html` | Static fallback page that auto-retries every 5s | Anywhere nginx can read on the host (e.g. `/var/www/aside-maintenance/maintenance.html`) |
| (this README's snippet) | nginx config telling it to serve the fallback on 502/503/504 | Plesk → Apache & nginx Settings → Additional nginx directives, or wherever your nginx vhost lives |

The fallback page is served by nginx **itself**, not by the Aside container — so it works even when the container is down (which is exactly when you need it).

## The nginx snippet

Paste this into the server-level config for the Aside domain. Adjust `root` to wherever you put `maintenance.html`.

```nginx
# When the upstream Aside container is unreachable (during a deploy,
# during a crash, while the new image is being built), serve a
# friendly auto-refresh page instead of nginx's default 502.
error_page 502 503 504 /__aside_maintenance.html;
location = /__aside_maintenance.html {
    internal;                              # not reachable directly
    root /var/www/aside-maintenance;       # directory containing maintenance.html
    try_files /maintenance.html =500;      # fall back to 500 if even the static is gone
    add_header Cache-Control "no-store";   # don't cache the maintenance page itself
}

# The actual upstream location. Yours probably already exists — just
# make sure the proxy_pass points at the right port.
location / {
    proxy_pass http://127.0.0.1:18790;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # WebSocket upgrade (needed for the voice client + channel-mode iOS app)
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400;
}
```

## Plesk-specific setup

If you're using Plesk:

1. **Copy the file to the host:**
   ```bash
   sudo mkdir -p /var/www/aside-maintenance
   sudo cp deploy/maintenance.html /var/www/aside-maintenance/
   sudo chown -R www-data:www-data /var/www/aside-maintenance  # or whatever user nginx runs as
   ```

2. **Add the nginx snippet** to your domain in Plesk:
   - Domains → your-domain.com → **Apache & nginx Settings**
   - Scroll to **Additional nginx directives** and paste the `error_page` + `location =` blocks above
   - Save

3. **Test it works** by stopping the container and curl'ing your domain. You should get the maintenance page instead of nginx's default 502:
   ```bash
   docker compose stop
   curl -sI https://your-domain.com/anything | head -1   # should be 502 or 503
   curl -s https://your-domain.com/anything | grep "Be right back"  # should match
   docker compose start
   ```

## How a clean deploy looks now

Combined with the `HEALTHCHECK` in `ClaudeVision/server/Dockerfile` and the `--wait` flag in `deploy.sh`:

1. `./deploy.sh` pulls latest, runs `docker compose up --build -d --wait`
2. Docker builds the new image while the old container is still running. **No downtime yet.**
3. Once built, the new container starts. The old one stops. There's a ~3–10s window where nginx can't reach the upstream.
4. During that window nginx serves `maintenance.html`. The page auto-retries `/health` every 5s.
5. New container passes HEALTHCHECK → `docker compose up --wait` returns success → deploy script exits clean.
6. The user's open tab automatically reloads the moment `/health` is reachable.

If the new container fails to become healthy within 120s, `deploy.sh` aborts with the last 50 log lines printed. Old data volume is preserved, so a manual rollback (`git checkout <previous-sha>` + redeploy) restores service.

## Troubleshooting

**The maintenance page isn't appearing — I still see nginx's default 502.**
- Plesk regenerates nginx configs on some panel actions. After saving the directives in **Additional nginx directives**, check the generated config matches with `cat /etc/nginx/plesk.conf.d/vhosts/<your-domain>.conf` or via the Plesk UI's "Show config" button.
- The `root` path must be readable by the nginx user. `ls -la /var/www/aside-maintenance/` and confirm permissions.
- `nginx -t` to verify the config is valid; `systemctl reload nginx` to apply.

**The maintenance page renders but doesn't auto-reload when the server comes back.**
- The inline JS polls `/health`. If your nginx config blocks JS execution (rare) or your CSP doesn't allow inline scripts, the auto-refresh dies and the user has to reload manually. The page is still a nicer error than the default.

**`docker compose up --wait` not recognized.**
- Requires Docker Compose v2.1.1 or newer. Update with `apt install docker-compose-plugin` on Debian/Ubuntu hosts.
