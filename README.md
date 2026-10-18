

<img width="524" height="204" alt="Screenshot 2026-10-19 at 1 34 19 AM" src="https://github.com/user-attachments/assets/dae94eb5-7682-4c99-b79e-01ad4c65386e" />



# Task Manager Microservices

A small task manager built to learn microservices patterns: independent
services, database-per-service, an API gateway, and RabbitMQ pub/sub for
asynchronous task events.

## Architecture

```
                     ┌─────────────┐
   client  ────────▶ │ api-gateway │  (port 4000)
                     └──────┬──────┘
      /auth │ /tasks │ /reports
              ┌───────────┴────────────────┐
              ▼                            ▼
      ┌───────────────┐           ┌──────────────────────────┐
      │  auth-service  │           │       task-service        │
      │  (port 4001)   │           │ HTTP 4002                  │
      └───────┬────────┘           │ + publishes to RabbitMQ    │
              │                    └──────────┬─────────┬──────┘
                    ▼                              │         │ AMQP publish
                  ┌───────────────┐                       │         ▼ task.* events
      │ postgres-auth  │                       │   ┌─────────────┐
      └───────────────┘                        │   │  RabbitMQ   │
                                                │   └──────┬──────┘
                     ┌───────────────────┐          ▼
                     │ notification-service│ ┌─────────────────┐
                     │ (RabbitMQ client)   │ │ reporting-consumer│
                     └───────────────────┘ │ (RabbitMQ client) │
                                            └────────┬────────┘
                                                     ▼
                                           ┌─────────────────┐
                                           │ postgres-reporting│
                                           └────────┬────────┘
                                                     ▲
                                           ┌─────────┴─────────┐
                                           │ reporting-service  │
                                           │ (Django, port 4004) │
                                           └────────────────────┘
```

- **api-gateway** — single entry point, reverse-proxies `/auth/*` to
  auth-service, `/tasks/*` to task-service, `/reports/*` to
  reporting-service
  (plain HTTP/JSON — the client-facing API).
- **auth-service** — registers users and issues JWTs. Owns its own Postgres
  database.
- **task-service** — CRUD for tasks, scoped to the authenticated user.
  Verifies JWTs itself (same shared secret as auth-service, no network
  call needed). Owns its own Postgres database and publishes durable
  task events to the RabbitMQ topic exchange `task_events`.
- **notification-service** — a durable RabbitMQ consumer with no HTTP API.
  It logs a simulated notification for every task event it receives.
- **reporting-service** / **reporting-consumer** — a Django app split
  across two containers built from the same image. `reporting-consumer` is a
  RabbitMQ management command that stores each event in `postgres-reporting`.
  `reporting-service` is the web process (gunicorn) exposing
  `GET /reports/health` and `GET /reports/summary` (total event count,
  broken down by event type and by user) by querying that same database.
Services find each other by container name via Docker Compose's built-in
DNS (e.g. `http://auth-service:4001`, `task-service:4003`) — no separate
service-discovery tool needed at this scale.
- **web-ui** — a standalone React + Vite single-page app (its own
  container, port 3000) that drives the whole flow: register/login, task
  CRUD, and the reports summary. It's a separate origin from
  api-gateway, so it calls the gateway's absolute URL
  (`VITE_API_BASE_URL`, baked in at build time) and the gateway allows
  it in via CORS (`WEB_UI_ORIGIN`).


## Running it

```bash
cp .env.example .env   # then edit JWT_SECRET / POSTGRES_PASSWORD if you like
docker compose up --build
```

This builds and starts all services and three Postgres instances. First
boot takes a bit longer while the Node and Django services build and run
their database migrations.

- Gateway: http://localhost:4000
- Web UI: http://localhost:3000

Watch the `notification-service` logs to see events arrive as you use the
API:

```bash
docker compose logs -f notification-service
```

## Trying it out

```bash
# 1. Register a user
curl -X POST http://localhost:4000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "hunter2"}'

# 2. Log in and grab the token
TOKEN=$(curl -s -X POST http://localhost:4000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "hunter2"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# 3. Create a task
curl -X POST http://localhost:4000/tasks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title": "Buy milk", "description": "2%"}'

# 4. List your tasks
curl http://localhost:4000/tasks -H "Authorization: Bearer $TOKEN"

# 5. Update a task (replace 1 with the task id from step 3)
curl -X PUT http://localhost:4000/tasks/1 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"status": "done"}'

# 6. Delete a task
curl -X DELETE http://localhost:4000/tasks/1 -H "Authorization: Bearer $TOKEN"

# 7. Check the aggregated stats
curl http://localhost:4000/reports/summary
```

After steps 3, 5, and 6, check the notification-service logs — you should
see a line like:

```
Notification: task "Buy milk" was created by alice
```

That line arrives through RabbitMQ, independently of the HTTP request/response
above. The reporting consumer receives its own durable queue copy and persists
it, which is what step 7's `/reports/summary` response reflects.

## End-to-end load test

The k6 script exercises registration and login, task creation/listing/update/
deletion, and waits for the reporting consumer to record each task's three
events. Install [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/),
make sure the Compose stack is running, then run from this directory:

```bash
k6 run load-test.js
```

By default it ramps up to 5 virtual users, holds that load for 1 minute, then
ramps down. Start with this low load and increase gradually:

```bash
k6 run -e VUS=10 -e RAMP_DURATION=30s -e HOLD_DURATION=2m load-test.js
```

The target defaults to `http://localhost:4000`; override it with
`-e BASE_URL=http://your-host:4000`. The default reporting wait is 20 seconds
per iteration and can be changed with `-e REPORTING_WAIT_SECONDS=30`.

Each virtual user creates one uniquely named account, reused for its iterations.
The script deletes each task after exercising it, but user accounts and
reporting events remain in the databases. Run it only against a development
environment whose data can grow, and watch container usage with `docker stats`
and event processing with
`docker compose logs -f notification-service reporting-consumer`.

## Project layout

```
microservices/
  api-gateway/            reverse proxy (Express + http-proxy-middleware)
  auth-service/            register/login, issues JWTs (Express + pg)
  task-service/            task CRUD (Express + pg) + RabbitMQ publisher
  notification-service/    RabbitMQ consumer, logs notifications
  reporting-service/       Django app: web process + consume_events management command
  web-ui/                  React + Vite SPA, served by a small Express static server
  docker-compose.yml
  .env.example
```

Each Node service is TypeScript, compiled with `tsc` in a multi-stage
Docker build (build stage installs devDependencies and compiles; the
runtime image only ships the compiled `dist/` and production
dependencies). reporting-service is Python/Django and uses `pika` for its
RabbitMQ consumer. web-ui follows the same multi-stage shape: a builder
stage runs `tsc && vite build`, and the runtime image just serves the
static `dist/` output.

To work on web-ui with hot reload instead of rebuilding the container each
time: `cd web-ui && npm install && npm run dev` (defaults to talking to
the gateway at http://localhost:4000, so run `docker compose up` for the
rest of the stack first).

## Notes / things to explore next

- Tasks aren't validated much beyond "title is required" — a natural next
  step if you want to practice more input validation.
- notification-service only logs; swapping in a real email/webhook call is
  a good next exercise.
- There's no automated test suite here (kept out of scope for this pass) —
  adding Jest + supertest per service would be a solid next step.
- RabbitMQ uses one durable queue per consumer, so notification and reporting
  each receive every event independently and unprocessed messages can be
  redelivered after a consumer restart.
- Each consumer queue is configured with a dead-letter exchange
  (`task_events.dlx`, fanout). A message that a consumer nacks without
  requeueing (e.g. it fails to parse) is routed there instead of being
  dropped, landing in that consumer's own queue
  (`notification-service.dlq` / `reporting-service.dlq`). Inspect or
  manually requeue them via the management UI at
  http://localhost:15672.
- `reporting-service` and `reporting-consumer` both run `migrate` on
  startup before their main process; since they start concurrently
  there's a small theoretical race on the very first boot (two processes
  creating the same tables). It's idempotent enough not to matter for a
  learning project, but a production setup would run migrations as a
  one-shot init step instead.

## Contributing

- `main` is protected: all changes go through a pull request.
- Branch naming: `feature/<service>-<desc>`, `fix/<service>-<desc>`, `chore/...`, `ci/...`, `docs/...`
- Commits and PR titles follow Conventional Commits, e.g. `feat(auth-service): add refresh token`.
- CI builds only the services you changed; `ci-success` must pass to merge.
