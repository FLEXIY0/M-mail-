# M-mail — Mattermost plugin

## Local dev environment

Mattermost Server **11.7.2** (Team Edition) + PostgreSQL 16 in Docker.

```bash
docker compose up -d
# http://localhost:8065
```

First run — create an admin and a team (local mode is enabled):

```bash
docker compose exec mattermost mmctl --local user create \
  --email admin@example.com --username admin --password 'Admin_12345!' --system-admin
docker compose exec mattermost mmctl --local team create --name dev --display-name Dev
docker compose exec mattermost mmctl --local team users add dev admin
```

Plugin uploads, developer and testing modes are enabled, so a built bundle can be installed with:

```bash
docker compose cp dist/<plugin>.tar.gz mattermost:/tmp/plugin.tar.gz
docker compose exec mattermost mmctl --local plugin add /tmp/plugin.tar.gz --force
docker compose exec mattermost mmctl --local plugin enable <plugin-id>
```

Stop: `docker compose down` (add `-v` to wipe data).
