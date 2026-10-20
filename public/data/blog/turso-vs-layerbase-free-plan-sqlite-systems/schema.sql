CREATE TABLE lbbench_users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  plan TEXT NOT NULL,
  benchmark_counter INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE lbbench_projects (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES lbbench_users(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE lbbench_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES lbbench_users(id),
  project_id INTEGER NOT NULL REFERENCES lbbench_projects(id),
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE lbbench_writes (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES lbbench_users(id),
  created_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);

CREATE INDEX lbbench_events_user_created
  ON lbbench_events(user_id, created_at DESC);
CREATE INDEX lbbench_events_project_created
  ON lbbench_events(project_id, created_at DESC);
CREATE INDEX lbbench_projects_owner
  ON lbbench_projects(owner_id);
CREATE INDEX lbbench_writes_run
  ON lbbench_writes(run_id);
