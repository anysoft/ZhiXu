-- ZhiXu Architecture v2.0 S0 candidate fresh DDL. NON-RUNTIME DESIGN ARTIFACT.
-- Not imported by application/bootstrap/ORM. No migration, DROP, data import or user-directory action.
-- SQLite >= 3.40 with JSON1, foreign_keys=ON, recursive_triggers=ON.
-- Unchanged domain declarations copied from frozen platformV8 + v9 observability CREATEs.
-- Candidate schema identity: zhixu.workspace.v2.s0.1; actual normalized signature in ddl-validation.json.
PRAGMA foreign_keys = ON;
PRAGMA recursive_triggers = ON;
BEGIN IMMEDIATE;

-- Unchanged referenced platform domains (complete declarations).
CREATE TABLE `Apps` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `name` VARCHAR(255), `scopes` JSON, `client_id` VARCHAR(255), `client_secret` VARCHAR(255), `tokens` JSON, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL, UNIQUE (`name`));

CREATE TABLE `Auths` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `ip` VARCHAR(255), `type` VARCHAR(255), `info` JSON, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL);

CREATE TABLE `ConfigAssetRevisions` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `asset_id` INTEGER NOT NULL REFERENCES `ConfigAssets` (`id`) ON DELETE RESTRICT, `revision_number` INTEGER NOT NULL, `checksum` VARCHAR(255) NOT NULL, `size` INTEGER NOT NULL, `storage_key` VARCHAR(255) NOT NULL UNIQUE, `createdAt` DATETIME NOT NULL, UNIQUE(asset_id,id));

CREATE TABLE `ConfigAssets` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `name` VARCHAR(255) NOT NULL UNIQUE, `description` TEXT NOT NULL DEFAULT '', `content_type` VARCHAR(255) NOT NULL DEFAULT 'TEXT', `is_secret` TINYINT(1) NOT NULL DEFAULT 0, `current_revision_id` INTEGER REFERENCES `ConfigAssetRevisions` (`id`) ON DELETE RESTRICT, `version` INTEGER NOT NULL DEFAULT 1, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL);

CREATE TABLE `CronTriggers` (`trigger_id` INTEGER PRIMARY KEY REFERENCES `TaskTriggers` (`id`) ON DELETE CASCADE, `expression` VARCHAR(255) NOT NULL, `timezone` VARCHAR(255) NOT NULL, `misfire_policy` VARCHAR(255) NOT NULL, `next_fire_at` DATETIME NOT NULL, `last_fire_at` DATETIME, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL);

CREATE TABLE `Dependences` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `name` VARCHAR(255), `type` NUMBER, `timestamp` VARCHAR(255), `status` NUMBER, `log` JSON, `remark` VARCHAR(255), `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL);

CREATE TABLE `Envs` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `value` TEXT, `operation` VARCHAR(255) NOT NULL DEFAULT 'SET', `is_secret` TINYINT(1) NOT NULL DEFAULT 0, `timestamp` VARCHAR(255), `status` INTEGER NOT NULL DEFAULT 0, `position` NUMBER, `name` VARCHAR(255) NOT NULL UNIQUE, `remarks` VARCHAR(255), `isPinned` NUMBER, `labels` JSON, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL);

CREATE TABLE `GitCredentials` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `name` VARCHAR(255) NOT NULL UNIQUE, `provider` VARCHAR(255) NOT NULL, `auth_type` VARCHAR(255) NOT NULL, `username` VARCHAR(255), `secret` TEXT, `public_key` TEXT, `known_hosts` TEXT, `capability` VARCHAR(255) NOT NULL DEFAULT 'READ', `status` VARCHAR(255) NOT NULL DEFAULT 'enabled', `last_test_at` DATETIME, `last_test_result` VARCHAR(255), `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL);

CREATE TABLE `GitUpdateTriggers` (`trigger_id` INTEGER PRIMARY KEY REFERENCES `TaskTriggers` (`id`) ON DELETE CASCADE, `mode` VARCHAR(255) NOT NULL, `path_filters` JSON NOT NULL DEFAULT '[]', `fire_on_initial` TINYINT(1) NOT NULL DEFAULT 0, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL);

CREATE TABLE NodeEnvironmentBuilds (
 id INTEGER PRIMARY KEY AUTOINCREMENT,environment_id INTEGER NOT NULL REFERENCES NodeEnvironments(id) ON DELETE RESTRICT,revision_id INTEGER NOT NULL,
 runtime_id INTEGER NOT NULL REFERENCES RuntimeInstallations(id) ON DELETE RESTRICT,toolchain_id INTEGER NOT NULL REFERENCES NodePackageManagerToolchains(id) ON DELETE RESTRICT,
 state VARCHAR(255) NOT NULL CHECK(state IN ('QUEUED','INSTALLING','VERIFYING','READY','FAILED','CANCELLED','INTERRUPTED','DELETING')),
 health VARCHAR(255) NOT NULL DEFAULT 'UNVERIFIED' CHECK(health IN ('UNVERIFIED','HEALTHY','INVALID','MISSING')),
 package_json TEXT NOT NULL DEFAULT '',lockfile TEXT NOT NULL DEFAULT '',lock_hash VARCHAR(255),resolved JSON NOT NULL DEFAULT '[]',resolved_hash VARCHAR(255),metadata JSON NOT NULL DEFAULT '{}',verified_at DATETIME,last_error VARCHAR(255),
 createdAt DATETIME NOT NULL,updatedAt DATETIME NOT NULL,UNIQUE(environment_id,id),
 FOREIGN KEY(environment_id,revision_id,runtime_id,toolchain_id) REFERENCES NodeEnvironmentRevisions(environment_id,id,runtime_id,toolchain_id) ON DELETE RESTRICT);

CREATE TABLE NodeEnvironmentRevisions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,environment_id INTEGER NOT NULL REFERENCES NodeEnvironments(id) ON DELETE RESTRICT,
 runtime_id INTEGER NOT NULL REFERENCES RuntimeInstallations(id) ON DELETE RESTRICT,toolchain_id INTEGER NOT NULL REFERENCES NodePackageManagerToolchains(id) ON DELETE RESTRICT,
 dependencies JSON NOT NULL DEFAULT '[]' CHECK(json_valid(dependencies)),spec_hash VARCHAR(255) NOT NULL,
 production_only TINYINT(1) NOT NULL DEFAULT 0 CHECK(production_only IN (0,1)),install_scripts_policy VARCHAR(255) NOT NULL DEFAULT 'ALLOW' CHECK(install_scripts_policy IN ('ALLOW','IGNORE')),
 createdAt DATETIME NOT NULL,updatedAt DATETIME NOT NULL,UNIQUE(environment_id,id),UNIQUE(environment_id,id,runtime_id,toolchain_id),
 FOREIGN KEY(toolchain_id,runtime_id) REFERENCES NodePackageManagerToolchains(id,runtime_id) ON DELETE RESTRICT);

CREATE TABLE NodeEnvironments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,name VARCHAR(255) NOT NULL UNIQUE,description VARCHAR(255) NOT NULL DEFAULT '',
 runtime_id INTEGER NOT NULL REFERENCES RuntimeInstallations(id) ON DELETE RESTRICT,toolchain_id INTEGER NOT NULL REFERENCES NodePackageManagerToolchains(id) ON DELETE RESTRICT,
 state VARCHAR(255) NOT NULL CHECK(state IN ('EMPTY','BUILDING','READY','ERROR','DELETING')),current_revision_id INTEGER,current_build_id INTEGER,version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),last_error VARCHAR(255),
 production_only TINYINT(1) NOT NULL DEFAULT 0 CHECK(production_only IN (0,1)),install_scripts_policy VARCHAR(255) NOT NULL DEFAULT 'ALLOW' CHECK(install_scripts_policy IN ('ALLOW','IGNORE')),
 createdAt DATETIME NOT NULL,updatedAt DATETIME NOT NULL,
 FOREIGN KEY(toolchain_id,runtime_id) REFERENCES NodePackageManagerToolchains(id,runtime_id) ON DELETE RESTRICT,
 FOREIGN KEY(id,current_revision_id) REFERENCES NodeEnvironmentRevisions(environment_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(id,current_build_id) REFERENCES NodeEnvironmentBuilds(environment_id,id) DEFERRABLE INITIALLY DEFERRED);

CREATE TABLE NodePackageManagerToolchains (
 id INTEGER PRIMARY KEY AUTOINCREMENT, runtime_id INTEGER NOT NULL REFERENCES RuntimeInstallations(id) ON DELETE RESTRICT,
 manager_type VARCHAR(255) NOT NULL CHECK(manager_type IN ('PNPM','NPM')), version VARCHAR(255) NOT NULL,
 state VARCHAR(255) NOT NULL CHECK(state IN ('INSTALLING','READY','ERROR','REMOVED')), metadata JSON NOT NULL DEFAULT '{}', verified_at DATETIME,last_error VARCHAR(255),
 createdAt DATETIME NOT NULL,updatedAt DATETIME NOT NULL,UNIQUE(runtime_id,manager_type,version),UNIQUE(id,runtime_id));

CREATE TABLE PythonEnvironmentBuilds (
 id INTEGER PRIMARY KEY AUTOINCREMENT, environment_id INTEGER NOT NULL REFERENCES PythonEnvironments(id) ON DELETE CASCADE,
 revision_id INTEGER NOT NULL, runtime_id INTEGER NOT NULL REFERENCES RuntimeInstallations(id) ON DELETE RESTRICT,
 state VARCHAR(255) NOT NULL CHECK(state IN ('QUEUED','CREATING','INSTALLING','VERIFYING','READY','FAILED','CANCELLED','INTERRUPTED','DELETING')),
 health VARCHAR(255) NOT NULL DEFAULT 'UNVERIFIED' CHECK(health IN ('UNVERIFIED','HEALTHY','INVALID','MISSING')),
 resolved JSON NOT NULL DEFAULT '[]', resolved_hash VARCHAR(255), freeze TEXT NOT NULL DEFAULT '', metadata JSON NOT NULL DEFAULT '{}',
 last_error VARCHAR(255), verified_at DATETIME, createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL, UNIQUE(environment_id,id),
 FOREIGN KEY(environment_id,revision_id,runtime_id) REFERENCES PythonEnvironmentRevisions(environment_id,id,runtime_id) ON DELETE RESTRICT);

CREATE TABLE PythonEnvironmentRevisions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, environment_id INTEGER NOT NULL REFERENCES PythonEnvironments(id) ON DELETE CASCADE,
 runtime_id INTEGER NOT NULL REFERENCES RuntimeInstallations(id) ON DELETE RESTRICT,
 dependencies JSON NOT NULL DEFAULT '[]', spec_hash VARCHAR(255) NOT NULL,
 createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL, UNIQUE(environment_id,id), UNIQUE(environment_id,id,runtime_id));

CREATE TABLE PythonEnvironments (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(255) NOT NULL UNIQUE, description VARCHAR(255) NOT NULL DEFAULT '',
 runtime_id INTEGER NOT NULL REFERENCES RuntimeInstallations(id) ON DELETE RESTRICT,
 state VARCHAR(255) NOT NULL CHECK(state IN ('EMPTY','BUILDING','READY','ERROR','DELETING')),
 current_revision_id INTEGER, current_build_id INTEGER, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), last_error VARCHAR(255),
 createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL,
 FOREIGN KEY(id,current_revision_id) REFERENCES PythonEnvironmentRevisions(environment_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(id,current_build_id) REFERENCES PythonEnvironmentBuilds(environment_id,id) DEFERRABLE INITIALLY DEFERRED);

CREATE TABLE "RunningInstances" (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `task_id` NUMBER NOT NULL, `pid` NUMBER, `log_path` VARCHAR(255), `started_at` NUMBER NOT NULL, `finished_at` NUMBER, `status` NUMBER NOT NULL DEFAULT 0, `exit_code` NUMBER, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL);

CREATE TABLE "RuntimeInstallations" (
 id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER NOT NULL REFERENCES RuntimeProviders(id) ON DELETE RESTRICT,
 language VARCHAR(255) NOT NULL CHECK(language IN ('PYTHON','NODE')), implementation VARCHAR(255) NOT NULL CHECK(implementation IN ('CPYTHON','NODEJS')),
 version VARCHAR(255) NOT NULL, state VARCHAR(255) NOT NULL CHECK(state IN ('INSTALLING','READY','VERIFYING','ERROR','REMOVING','MISSING','REMOVED')),
 executable_relative_path VARCHAR(255) NOT NULL, installed_at DATETIME, verified_at DATETIME, metadata JSON NOT NULL DEFAULT '{}',
 last_error VARCHAR(255), createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL);

CREATE TABLE "RuntimeOperations" (
 id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER NOT NULL REFERENCES RuntimeProviders(id) ON DELETE RESTRICT,
 runtime_id INTEGER REFERENCES RuntimeInstallations(id) ON DELETE RESTRICT,
 operation_type VARCHAR(255) NOT NULL CHECK(operation_type IN ('PROVIDER_INSTALL','PROVIDER_UPDATE','PROVIDER_VERIFY','PROVIDER_REPAIR','CATALOG_REFRESH','RUNTIME_INSTALL','RUNTIME_VERIFY','RUNTIME_REMOVE','RUNTIME_REPAIR','PYTHON_ENV_BUILD','PYTHON_ENV_REBUILD','PYTHON_ENV_VERIFY','PYTHON_ENV_PROMOTE','PYTHON_ENV_DELETE','PYTHON_ENV_DELETE_BUILD','NODE_CATALOG_REFRESH','NODE_RUNTIME_INSTALL','NODE_RUNTIME_VERIFY','NODE_RUNTIME_REPAIR','NODE_RUNTIME_REMOVE','NODE_PACKAGE_MANAGER_INSTALL','NODE_PACKAGE_MANAGER_VERIFY','NODE_PACKAGE_MANAGER_REMOVE','NODE_ENV_BUILD','NODE_ENV_REBUILD','NODE_ENV_RESOLVE','NODE_ENV_VERIFY','NODE_ENV_PROMOTE','NODE_ENV_DELETE','NODE_ENV_DELETE_BUILD')),
 status VARCHAR(255) NOT NULL CHECK(status IN ('QUEUED','RUNNING','SUCCESS','FAILED','CANCELLED','INTERRUPTED')),
 stage VARCHAR(255) NOT NULL, owner_token VARCHAR(255) NOT NULL, owner_pid INTEGER NOT NULL,
 cancel_requested TINYINT(1) NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)), started_at DATETIME, finished_at DATETIME, exit_code INTEGER,
 log_identity VARCHAR(255) NOT NULL UNIQUE, error_code VARCHAR(255), error_summary VARCHAR(255), metadata JSON NOT NULL DEFAULT '{}',
 createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL);

CREATE TABLE "RuntimeProviders" (
 id INTEGER PRIMARY KEY AUTOINCREMENT, language VARCHAR(255) NOT NULL CHECK(language IN ('PYTHON','NODE')),
 provider_type VARCHAR(255) NOT NULL CHECK(provider_type IN ('PYENV','NODE_DISTRIBUTION')),
 state VARCHAR(255) NOT NULL CHECK(state IN ('UNINITIALIZED','INSTALLING','READY','UPDATING','ERROR','MISSING')),
 provider_version VARCHAR(255), provider_revision VARCHAR(255), install_root VARCHAR(255) NOT NULL,
 catalog JSON NOT NULL DEFAULT '[]', last_refresh_at DATETIME, last_verified_at DATETIME, last_error VARCHAR(255),
 version INTEGER NOT NULL DEFAULT 1, createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL);

CREATE TABLE "SchedulerProjections" (`id` INTEGER PRIMARY KEY REFERENCES Tasks(id) ON DELETE CASCADE, `name` VARCHAR(255), `command` VARCHAR(255), `schedule` VARCHAR(255), `timestamp` VARCHAR(255), `saved` TINYINT(1), `status` NUMBER, `isSystem` NUMBER, `pid` NUMBER, `isDisabled` NUMBER, `isPinned` NUMBER, `log_path` VARCHAR(255), `queued_token` VARCHAR(255), `labels` JSON, `last_running_time` NUMBER, `last_execution_time` NUMBER, `sub_id` NUMBER, `discovery_key` VARCHAR(255), `source_relative_path` VARCHAR(255), `discovery_definition` JSON, `env_profile_id` INTEGER REFERENCES `EnvironmentProfiles` (`id`) ON DELETE RESTRICT, `extra_schedules` JSON, `log_name` VARCHAR(255), `allow_multiple_instances` NUMBER, `work_dir` VARCHAR(255), `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL, UNIQUE (`sub_id`, `discovery_key`));

CREATE TABLE "TaskEnvVariables" (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `name` VARCHAR(255) NOT NULL, `value` TEXT, `status` VARCHAR(255) NOT NULL DEFAULT 'enabled', `operation` VARCHAR(255) NOT NULL DEFAULT 'SET', `is_secret` TINYINT(1) NOT NULL DEFAULT 0, `position` FLOAT DEFAULT '0', `labels` JSON DEFAULT '[]', `task_id` INTEGER NOT NULL REFERENCES `Tasks` (`id`) ON DELETE CASCADE, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL);

CREATE TABLE "TaskHooks" (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `task_id` INTEGER NOT NULL REFERENCES `Tasks` (`id`) ON DELETE CASCADE, `name` VARCHAR(255) NOT NULL, `phase` VARCHAR(255) NOT NULL, `command` TEXT NOT NULL, `cwd_base` VARCHAR(255) NOT NULL DEFAULT 'TASK_CWD', `position` INTEGER NOT NULL, `timeout_seconds` INTEGER NOT NULL DEFAULT 60, `failure_policy` VARCHAR(255) NOT NULL, `enabled` TINYINT(1) NOT NULL DEFAULT 1, `version` INTEGER NOT NULL DEFAULT 1, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL);

CREATE TABLE `TaskRunAttempts` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `task_run_id` INTEGER NOT NULL REFERENCES `TaskRuns` (`id`) ON DELETE CASCADE, `attempt_number` INTEGER NOT NULL, `status` VARCHAR(255) NOT NULL, `started_at` DATETIME NOT NULL, `finished_at` DATETIME, `exit_code` INTEGER, `signal` VARCHAR(255), `error_code` VARCHAR(255), `error_summary` VARCHAR(255), `duration_ms` INTEGER, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL, result JSON, retry_decision INTEGER NOT NULL DEFAULT 0, retry_delay INTEGER NOT NULL DEFAULT 0);

CREATE TABLE `TaskRuntimeBindings` (`task_id` INTEGER PRIMARY KEY REFERENCES `Tasks` (`id`) ON DELETE CASCADE, `kind` VARCHAR(255) NOT NULL, `python_environment_id` INTEGER REFERENCES `PythonEnvironments` (`id`) ON DELETE RESTRICT, `node_environment_id` INTEGER REFERENCES `NodeEnvironments` (`id`) ON DELETE RESTRICT, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL);

CREATE TABLE "TaskStats" (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `ref_id` NUMBER NOT NULL, `date` VARCHAR(255) NOT NULL, `run_count` NUMBER DEFAULT 0, `success_count` NUMBER DEFAULT 0, `fail_count` NUMBER DEFAULT 0, `total_time` NUMBER DEFAULT 0, `max_time` NUMBER DEFAULT 0, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL);

CREATE TABLE `TaskTriggers` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `task_id` INTEGER NOT NULL REFERENCES `Tasks` (`id`) ON DELETE CASCADE, `type` VARCHAR(255) NOT NULL, `origin` VARCHAR(255) NOT NULL DEFAULT 'USER', `enabled` TINYINT(1) NOT NULL DEFAULT 1, `version` INTEGER NOT NULL DEFAULT 1, `discovery_key` VARCHAR(255), `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL);

CREATE TABLE "TaskViews" (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `name` VARCHAR(255), `position` NUMBER, `isDisabled` NUMBER, `filters` JSON, `sorts` JSON, `filterRelation` VARCHAR(255), `type` NUMBER, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL, UNIQUE (`name`));

CREATE TABLE `WebhookTriggers` (`trigger_id` INTEGER PRIMARY KEY REFERENCES `TaskTriggers` (`id`) ON DELETE CASCADE, `public_id` VARCHAR(255) NOT NULL UNIQUE, `secret_hash` VARCHAR(255) NOT NULL, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL);

CREATE TABLE TaskRunEvents (id INTEGER PRIMARY KEY AUTOINCREMENT, task_run_id INTEGER NOT NULL REFERENCES TaskRuns(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, type TEXT NOT NULL, metadata JSON NOT NULL DEFAULT '{}', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(task_run_id,sequence));

CREATE TABLE TaskHealthStates (task_id INTEGER PRIMARY KEY REFERENCES Tasks(id) ON DELETE CASCADE, last_run_id INTEGER REFERENCES TaskRuns(id) ON DELETE SET NULL, last_terminal_status TEXT, last_success_at DATETIME, last_failure_at DATETIME, consecutive_failures INTEGER NOT NULL DEFAULT 0, health_state TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(health_state IN ('UNKNOWN','HEALTHY','FAILING')), failure_alert_open INTEGER NOT NULL DEFAULT 0 CHECK(failure_alert_open IN (0,1)), updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE NotificationChannels (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)), version INTEGER NOT NULL DEFAULT 1, non_secret_config JSON NOT NULL DEFAULT '{}', secret TEXT, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)), created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE TaskNotificationPolicies (task_id INTEGER PRIMARY KEY REFERENCES Tasks(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 0, notify_success INTEGER NOT NULL DEFAULT 0, notify_failure INTEGER NOT NULL DEFAULT 0, notify_timeout INTEGER NOT NULL DEFAULT 0, notify_interrupted INTEGER NOT NULL DEFAULT 0, notify_cancelled INTEGER NOT NULL DEFAULT 0, notify_recovery INTEGER NOT NULL DEFAULT 0, failure_threshold INTEGER NOT NULL DEFAULT 1 CHECK(failure_threshold BETWEEN 1 AND 1000), repeat_every_failures INTEGER NOT NULL DEFAULT 0 CHECK(repeat_every_failures BETWEEN 0 AND 1000), channel_mode TEXT NOT NULL DEFAULT 'DEFAULT' CHECK(channel_mode IN ('DEFAULT','EXPLICIT','NONE')), version INTEGER NOT NULL DEFAULT 1);

CREATE TABLE TaskNotificationChannelBindings (task_id INTEGER NOT NULL REFERENCES Tasks(id) ON DELETE CASCADE, channel_id INTEGER NOT NULL REFERENCES NotificationChannels(id) ON DELETE RESTRICT, PRIMARY KEY(task_id,channel_id));

CREATE TABLE NotificationOutbox (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, task_id INTEGER REFERENCES Tasks(id) ON DELETE SET NULL, task_run_id INTEGER REFERENCES TaskRuns(id) ON DELETE RESTRICT, channel_id INTEGER NOT NULL REFERENCES NotificationChannels(id) ON DELETE RESTRICT, dedupe_key TEXT NOT NULL UNIQUE, message JSON NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SENDING','SENT','RETRY','DEAD')), attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, claim_token TEXT, claimed_at DATETIME, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, sent_at DATETIME, last_error_code TEXT);

CREATE TABLE NotificationDeliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, outbox_id INTEGER NOT NULL REFERENCES NotificationOutbox(id) ON DELETE RESTRICT, attempt INTEGER NOT NULL, started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at DATETIME, result TEXT NOT NULL, error_code TEXT, UNIQUE(outbox_id,attempt));

-- Candidate identity is independent of platform v9; values inserted only by isolated validator here.
CREATE TABLE PlatformMetadata (
 schema_identity TEXT PRIMARY KEY NOT NULL CHECK(schema_identity='zhixu.workspace.v2.s0.1'),
 schema_version INTEGER NOT NULL CHECK(schema_version=1),
 model_contract TEXT NOT NULL CHECK(model_contract='S0-2026-11-13'),
 schema_signature TEXT NOT NULL CHECK(length(schema_signature)=64),
 initialized_at TEXT NOT NULL
);
CREATE TABLE Repositories (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, provider TEXT NOT NULL,
 remote_url TEXT NOT NULL, normalized_url TEXT NOT NULL UNIQUE, host TEXT, path TEXT, owner TEXT, repository_name TEXT,
 default_credential_id INTEGER REFERENCES GitCredentials(id) ON DELETE RESTRICT,
 status TEXT NOT NULL DEFAULT 'unknown', storage_state TEXT NOT NULL DEFAULT 'UNINITIALIZED', storage_path TEXT,
 last_fetch_at TEXT,last_fetch_status TEXT,last_error TEXT,default_branch TEXT,last_known_remote_head TEXT,
 remote_refs_count INTEGER NOT NULL DEFAULT 0 CHECK(remote_refs_count>=0),tags_count INTEGER NOT NULL DEFAULT 0 CHECK(tags_count>=0),
 createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE Workspaces (
 id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(id>0), name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 255),
 type TEXT NOT NULL CHECK(type IN ('LOCAL','GIT')),
 root_key TEXT GENERATED ALWAYS AS ('workspaces/'||lower(type)||'/ws-'||id) STORED UNIQUE,
 lifecycle_state TEXT NOT NULL DEFAULT 'CREATING' CHECK(lifecycle_state IN ('CREATING','READY','ARCHIVED','DELETE_REQUESTED','TOMBSTONED','ERROR','RECOVERY_REQUIRED')),
 storage_state TEXT NOT NULL DEFAULT 'PROVISIONING' CHECK(storage_state IN ('PROVISIONING','PRESENT','RECLAIMING','RECLAIMED')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), source_generation INTEGER NOT NULL DEFAULT 1 CHECK(source_generation>0),
 content_revision INTEGER NOT NULL DEFAULT 1 CHECK(content_revision>0),
 file_count INTEGER NOT NULL DEFAULT 0 CHECK(file_count>=0),total_bytes INTEGER NOT NULL DEFAULT 0 CHECK(total_bytes>=0),
 content_inventory_hash TEXT CHECK(content_inventory_hash IS NULL OR (length(content_inventory_hash)=64 AND content_inventory_hash NOT GLOB '*[^0-9a-f]*')),
 root_device INTEGER CHECK(root_device IS NULL OR root_device>=0),root_inode INTEGER CHECK(root_inode IS NULL OR root_inode>0),
 root_owner_token TEXT, default_env_profile_id INTEGER,
 last_error_code TEXT, deleted_at TEXT,reclaimed_at TEXT,metadata_purge_after TEXT,
 createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(id,type),
 FOREIGN KEY(id,default_env_profile_id) REFERENCES EnvironmentProfiles(workspace_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 CHECK((root_device IS NULL)=(root_inode IS NULL)),
 CHECK(storage_state NOT IN ('PRESENT','RECLAIMING') OR (root_device IS NOT NULL AND root_inode IS NOT NULL AND root_owner_token IS NOT NULL)),
 CHECK(lifecycle_state NOT IN ('READY','ARCHIVED') OR (storage_state='PRESENT' AND content_inventory_hash IS NOT NULL)),
 CHECK(storage_state<>'RECLAIMED' OR (lifecycle_state='TOMBSTONED' AND root_device IS NULL AND root_inode IS NULL AND reclaimed_at IS NOT NULL))
);
CREATE TABLE GitWorkspaces (
 workspace_id INTEGER PRIMARY KEY REFERENCES Workspaces(id) ON DELETE CASCADE,
 workspace_type TEXT NOT NULL DEFAULT 'GIT' CHECK(workspace_type='GIT'),
 repository_id INTEGER NOT NULL REFERENCES Repositories(id) ON DELETE RESTRICT,
 ref_type TEXT NOT NULL CHECK(ref_type IN ('branch','tag','commit')),ref_name TEXT NOT NULL CHECK(length(ref_name)>0),
 private_branch TEXT UNIQUE,
 resolved_commit TEXT NOT NULL CHECK(length(resolved_commit) IN (40,64) AND resolved_commit NOT GLOB '*[^0-9a-f]*'),
 last_verified_commit TEXT CHECK(last_verified_commit IS NULL OR (length(last_verified_commit) IN (40,64) AND last_verified_commit NOT GLOB '*[^0-9a-f]*')),
 baseline_established INTEGER NOT NULL DEFAULT 0 CHECK(baseline_established IN (0,1)),
 baseline_sync_run_id INTEGER REFERENCES WorkspaceSyncRuns(id) ON DELETE SET NULL,
 applied_commit TEXT CHECK(applied_commit IS NULL OR (length(applied_commit) IN (40,64) AND applied_commit NOT GLOB '*[^0-9a-f]*')),
 dirty_state TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(dirty_state IN ('UNKNOWN','CLEAN','DIRTY','CONFLICT')),
 status_snapshot JSON NOT NULL DEFAULT '{}' CHECK(json_valid(status_snapshot)),last_update_at TEXT,last_error_code TEXT,
 createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(workspace_id,workspace_type) REFERENCES Workspaces(id,type) ON DELETE CASCADE,
 UNIQUE(workspace_id,baseline_established),
 CHECK((ref_type='branch' AND private_branch IS NOT NULL AND private_branch='ws-'||workspace_id) OR (ref_type IN ('tag','commit') AND private_branch IS NULL))
);
CREATE INDEX git_workspaces_repository_ref ON GitWorkspaces(repository_id,ref_type,ref_name);
CREATE TABLE EnvironmentProfiles (
 id INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id INTEGER NOT NULL REFERENCES Workspaces(id) ON DELETE RESTRICT,
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 255),description TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'enabled' CHECK(status IN ('enabled','disabled')),version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(workspace_id,name),UNIQUE(workspace_id,id)
);
CREATE TABLE WorkspaceProfileVariables (
 id INTEGER PRIMARY KEY AUTOINCREMENT,profile_id INTEGER NOT NULL REFERENCES EnvironmentProfiles(id) ON DELETE CASCADE,
 name TEXT NOT NULL CHECK(length(name)>0),value TEXT,status TEXT NOT NULL DEFAULT 'enabled' CHECK(status IN ('enabled','disabled')),
 operation TEXT NOT NULL DEFAULT 'SET' CHECK(operation IN ('SET','UNSET')),is_secret INTEGER NOT NULL DEFAULT 0 CHECK(is_secret IN (0,1)),
 position REAL NOT NULL DEFAULT 0,labels JSON NOT NULL DEFAULT '[]' CHECK(json_valid(labels)),
 createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(profile_id,name),CHECK((operation='SET' AND value IS NOT NULL) OR (operation='UNSET' AND value IS NULL))
);
CREATE TABLE WorkspaceRuntimeDefaults (
 id INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id INTEGER NOT NULL REFERENCES Workspaces(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('PYTHON','NODE')),
 python_environment_id INTEGER REFERENCES PythonEnvironments(id) ON DELETE RESTRICT,
 node_environment_id INTEGER REFERENCES NodeEnvironments(id) ON DELETE RESTRICT,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(workspace_id,kind),
 CHECK((kind='PYTHON' AND python_environment_id IS NOT NULL AND node_environment_id IS NULL) OR (kind='NODE' AND node_environment_id IS NOT NULL AND python_environment_id IS NULL))
);
CREATE TABLE WorkspaceConfigBindings (
 id INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id INTEGER NOT NULL REFERENCES Workspaces(id) ON DELETE CASCADE,
 asset_id INTEGER NOT NULL REFERENCES ConfigAssets(id) ON DELETE RESTRICT,revision_id INTEGER,
 operation TEXT NOT NULL DEFAULT 'ATTACH' CHECK(operation='ATTACH'),
 target_base TEXT NOT NULL CHECK(target_base IN ('WORKSPACE_ROOT','TASK_CWD')),target_path TEXT NOT NULL CHECK(length(target_path)>0),
 materialization_mode TEXT NOT NULL DEFAULT 'COPY' CHECK(materialization_mode IN ('COPY','SYMLINK')),
 conflict_policy TEXT NOT NULL DEFAULT 'FAIL_IF_EXISTS' CHECK(conflict_policy IN ('FAIL_IF_EXISTS','BACKUP_AND_RESTORE')),
 writable INTEGER NOT NULL DEFAULT 0 CHECK(writable IN (0,1)),enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(workspace_id,target_base,target_path),
 FOREIGN KEY(asset_id,revision_id) REFERENCES ConfigAssetRevisions(asset_id,id) ON DELETE RESTRICT
);
CREATE TABLE Tasks (
 id INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id INTEGER NOT NULL REFERENCES Workspaces(id) ON DELETE RESTRICT,
 name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 origin TEXT NOT NULL DEFAULT 'MANUAL' CHECK(origin IN ('MANUAL','DISCOVERED')),
 discovered_workspace_id INTEGER REFERENCES Workspaces(id) ON DELETE RESTRICT,
 discovery_key TEXT,discovery_definition JSON CHECK(discovery_definition IS NULL OR json_valid(discovery_definition)),
 discovery_state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(discovery_state IN ('ACTIVE','RETIRED')),
 env_profile_id INTEGER,arguments JSON NOT NULL DEFAULT '[]' CHECK(json_valid(arguments) AND json_type(arguments)='array'),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(id,workspace_id),UNIQUE(discovered_workspace_id,discovery_key),
 FOREIGN KEY(workspace_id,env_profile_id) REFERENCES EnvironmentProfiles(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(id,workspace_id) REFERENCES TaskSources(task_id,workspace_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((origin='MANUAL' AND discovered_workspace_id IS NULL AND discovery_key IS NULL AND discovery_state='ACTIVE') OR
       (origin='DISCOVERED' AND discovered_workspace_id IS NOT NULL AND discovered_workspace_id=workspace_id AND discovery_key IS NOT NULL AND length(discovery_key)=64 AND discovery_key NOT GLOB '*[^0-9a-f]*')),
 CHECK(discovery_state<>'RETIRED' OR enabled=0)
);
CREATE TABLE TaskSources (
 task_id INTEGER PRIMARY KEY REFERENCES Tasks(id) ON DELETE CASCADE,workspace_id INTEGER NOT NULL REFERENCES Workspaces(id) ON DELETE RESTRICT,
 type TEXT NOT NULL DEFAULT 'WORKSPACE_ENTRYPOINT' CHECK(type='WORKSPACE_ENTRYPOINT'),
 relative_entrypoint TEXT NOT NULL CHECK(length(relative_entrypoint)>0 AND substr(relative_entrypoint,1,1)<>'/' AND instr(relative_entrypoint,char(92))=0 AND relative_entrypoint NOT LIKE '../%' AND relative_entrypoint NOT LIKE '%/../%' AND relative_entrypoint NOT LIKE '%/..' AND relative_entrypoint<>'..'),
 language TEXT NOT NULL CHECK(language IN ('PYTHON','JAVASCRIPT','TYPESCRIPT','SHELL')),
 cwd_mode TEXT NOT NULL DEFAULT 'ENTRYPOINT_DIR' CHECK(cwd_mode IN ('ENTRYPOINT_DIR','WORKSPACE_ROOT','CUSTOM_RELATIVE')),cwd_relative_path TEXT,
 createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(task_id,workspace_id),
 FOREIGN KEY(task_id,workspace_id) REFERENCES Tasks(id,workspace_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 CHECK((cwd_mode='CUSTOM_RELATIVE' AND cwd_relative_path IS NOT NULL AND length(cwd_relative_path)>0) OR (cwd_mode<>'CUSTOM_RELATIVE' AND cwd_relative_path IS NULL))
);
CREATE INDEX task_sources_workspace ON TaskSources(workspace_id);
CREATE TABLE TaskConfigBindings (
 id INTEGER PRIMARY KEY AUTOINCREMENT,task_id INTEGER NOT NULL REFERENCES Tasks(id) ON DELETE CASCADE,
 asset_id INTEGER REFERENCES ConfigAssets(id) ON DELETE RESTRICT,revision_id INTEGER,
 operation TEXT NOT NULL DEFAULT 'ATTACH' CHECK(operation IN ('ATTACH','MASK')),
 target_base TEXT NOT NULL CHECK(target_base IN ('WORKSPACE_ROOT','TASK_CWD')),target_path TEXT NOT NULL CHECK(length(target_path)>0),
 materialization_mode TEXT NOT NULL DEFAULT 'COPY' CHECK(materialization_mode IN ('COPY','SYMLINK')),
 conflict_policy TEXT NOT NULL DEFAULT 'FAIL_IF_EXISTS' CHECK(conflict_policy IN ('FAIL_IF_EXISTS','BACKUP_AND_RESTORE')),
 writable INTEGER NOT NULL DEFAULT 0 CHECK(writable IN (0,1)),enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(task_id,target_base,target_path),
 FOREIGN KEY(asset_id,revision_id) REFERENCES ConfigAssetRevisions(asset_id,id) ON DELETE RESTRICT,
 CHECK((operation='ATTACH' AND asset_id IS NOT NULL) OR (operation='MASK' AND asset_id IS NULL AND revision_id IS NULL))
);
CREATE TABLE TaskExecutionSettings (
 task_id INTEGER PRIMARY KEY REFERENCES Tasks(id) ON DELETE CASCADE,timeout_seconds INTEGER CHECK(timeout_seconds IS NULL OR timeout_seconds>0),
 max_attempts INTEGER NOT NULL DEFAULT 1 CHECK(max_attempts BETWEEN 1 AND 100),initial_delay_seconds INTEGER NOT NULL DEFAULT 0 CHECK(initial_delay_seconds>=0),
 backoff TEXT NOT NULL DEFAULT 'FIXED' CHECK(backoff IN ('FIXED','EXPONENTIAL')),
 concurrency TEXT NOT NULL DEFAULT 'FORBID' CHECK(concurrency IN ('FORBID','QUEUE','ALLOW')),
 notification TEXT NOT NULL DEFAULT 'NONE' CHECK(notification IN ('NONE','SUCCESS','FAILURE','ALWAYS')),
 createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE WorkspaceOperations (
 id TEXT PRIMARY KEY NOT NULL,workspace_id INTEGER NOT NULL REFERENCES Workspaces(id) ON DELETE RESTRICT,
 operation_type TEXT NOT NULL CHECK(operation_type IN ('CREATE','ARCHIVE','UNARCHIVE','DELETE_RECLAIM','RECOVER','FILE_MUTATION')),
 status TEXT NOT NULL CHECK(status IN ('PENDING','RUNNING','DRAINING','SUCCEEDED','FAILED','CANCELLED','RECOVERY_REQUIRED')),
 phase TEXT NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 expected_workspace_version INTEGER NOT NULL CHECK(expected_workspace_version>0),owner_token TEXT,journal_key TEXT NOT NULL UNIQUE,
 root_marker JSON NOT NULL DEFAULT '{}' CHECK(json_valid(root_marker)),preservation_receipt JSON CHECK(preservation_receipt IS NULL OR json_valid(preservation_receipt)),
 error_code TEXT,submitted_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,
 UNIQUE(workspace_id,request_key),UNIQUE(request_key)
);
CREATE UNIQUE INDEX workspace_operation_active ON WorkspaceOperations(workspace_id) WHERE status IN ('PENDING','RUNNING','DRAINING','RECOVERY_REQUIRED');
CREATE TABLE WorkspaceSyncPolicies (
 workspace_id INTEGER PRIMARY KEY REFERENCES GitWorkspaces(workspace_id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),update_mode TEXT NOT NULL DEFAULT 'MANUAL' CHECK(update_mode IN ('MANUAL','SCHEDULED')),
 schedule_kind TEXT NOT NULL DEFAULT 'NONE' CHECK(schedule_kind IN ('NONE','CRON','INTERVAL')),
 cron_expression TEXT,timezone TEXT NOT NULL DEFAULT 'UTC',interval_ms INTEGER CHECK(interval_ms IS NULL OR interval_ms>0),anchor_at TEXT,
 misfire_policy TEXT NOT NULL DEFAULT 'SKIP' CHECK(misfire_policy IN ('SKIP','FIRE_ONCE')),next_due_at TEXT,last_claimed_slot TEXT,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((update_mode='MANUAL' AND schedule_kind='NONE' AND cron_expression IS NULL AND interval_ms IS NULL AND anchor_at IS NULL) OR
       (update_mode='SCHEDULED' AND schedule_kind='CRON' AND cron_expression IS NOT NULL AND interval_ms IS NULL AND anchor_at IS NULL) OR
       (update_mode='SCHEDULED' AND schedule_kind='INTERVAL' AND cron_expression IS NULL AND interval_ms IS NOT NULL AND anchor_at IS NOT NULL))
);
CREATE TABLE WorkspaceDiscoveryPolicies (
 workspace_id INTEGER PRIMARY KEY REFERENCES GitWorkspaces(workspace_id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),includes JSON NOT NULL DEFAULT '["**/*"]' CHECK(json_valid(includes) AND json_type(includes)='array'),
 excludes JSON NOT NULL DEFAULT '[]' CHECK(json_valid(excludes) AND json_type(excludes)='array'),
 languages JSON NOT NULL DEFAULT '["PYTHON","JAVASCRIPT","TYPESCRIPT","SHELL"]' CHECK(json_valid(languages) AND json_type(languages)='array'),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),last_reconciled_at TEXT,last_result JSON CHECK(last_result IS NULL OR json_valid(last_result))
);
CREATE TABLE WorkspaceDiscoverySuppressions (
 workspace_id INTEGER NOT NULL REFERENCES GitWorkspaces(workspace_id) ON DELETE CASCADE,
 discovery_key TEXT NOT NULL CHECK(length(discovery_key)=64),relative_entrypoint TEXT NOT NULL,reason TEXT NOT NULL DEFAULT 'USER_IGNORED',
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(workspace_id,discovery_key)
);
CREATE TABLE WorkspaceSyncRuns (
 id INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id INTEGER NOT NULL REFERENCES Workspaces(id) ON DELETE RESTRICT,
 policy_version INTEGER NOT NULL CHECK(policy_version>0),source_generation INTEGER NOT NULL CHECK(source_generation>0),
 request_key TEXT NOT NULL,request_hash TEXT NOT NULL CHECK(length(request_hash)=64),trigger_source TEXT NOT NULL CHECK(trigger_source IN ('MANUAL','CRON','INTERVAL','RECOVERY')),
 schedule_slot TEXT,initial INTEGER NOT NULL DEFAULT 0 CHECK(initial IN (0,1)),source_snapshot JSON NOT NULL CHECK(json_valid(source_snapshot) AND json_type(source_snapshot)='object'),
 before_commit TEXT,target_commit TEXT,actual_commit TEXT,after_commit TEXT,
 status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','RUNNING','NO_CHANGE','SUCCESS','BLOCKED','FAILED','RECOVERY_REQUIRED','CANCELLED','INTERRUPTED')),
 phase TEXT NOT NULL DEFAULT 'QUEUED',git_update_status TEXT NOT NULL DEFAULT 'NOT_STARTED' CHECK(git_update_status IN ('NOT_STARTED','FETCHING','APPLYING','APPLIED','UNCHANGED','FAILED')),
 discovery_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED' CHECK(discovery_status IN ('NOT_REQUESTED','PENDING','RUNNING','SUCCESS','FAILED')),
 update_outbox_id INTEGER,
 event_status TEXT NOT NULL DEFAULT 'NOT_COMMITTED' CHECK(event_status IN ('NOT_COMMITTED','PENDING','DISPATCHED','BLOCKED')),
 content_revision INTEGER,owner_token TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),error_code TEXT,
 started_at TEXT,finished_at TEXT,submitted_at TEXT NOT NULL,log_identity TEXT NOT NULL UNIQUE,
 UNIQUE(workspace_id,request_key),UNIQUE(id,workspace_id),
 FOREIGN KEY(update_outbox_id,workspace_id) REFERENCES WorkspaceUpdateOutbox(id,workspace_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(status<>'SUCCESS' OR (update_outbox_id=id AND event_status IN ('PENDING','DISPATCHED','BLOCKED'))),
 CHECK(status='SUCCESS' OR update_outbox_id IS NULL),
 CHECK(status<>'SUCCESS' OR (actual_commit IS NOT NULL AND target_commit IS NOT NULL AND after_commit IS NOT NULL AND actual_commit=target_commit AND after_commit=actual_commit AND (git_update_status='APPLIED' OR (initial=1 AND git_update_status='UNCHANGED' AND before_commit=actual_commit)) AND discovery_status IN ('NOT_REQUESTED','SUCCESS') AND content_revision IS NOT NULL)),
 CHECK(status<>'NO_CHANGE' OR (initial=0 AND before_commit IS NOT NULL AND target_commit IS NOT NULL AND actual_commit IS NOT NULL AND after_commit IS NOT NULL AND actual_commit=before_commit AND after_commit=actual_commit AND git_update_status='UNCHANGED' AND event_status='NOT_COMMITTED')),
 CHECK(event_status='NOT_COMMITTED' OR status='SUCCESS'),
 CHECK(status NOT IN ('FAILED','CANCELLED','INTERRUPTED','BLOCKED') OR git_update_status<>'APPLIED'),
 CHECK(status<>'QUEUED' OR owner_token IS NULL),CHECK(status<>'RUNNING' OR owner_token IS NOT NULL)
);
CREATE UNIQUE INDEX workspace_sync_active ON WorkspaceSyncRuns(workspace_id) WHERE status IN ('QUEUED','RUNNING','RECOVERY_REQUIRED');
CREATE INDEX workspace_sync_history ON WorkspaceSyncRuns(workspace_id,id DESC);
CREATE TABLE WorkspaceUpdateOutbox (
 id INTEGER PRIMARY KEY,workspace_id INTEGER NOT NULL REFERENCES Workspaces(id) ON DELETE RESTRICT,
 sync_run_id INTEGER NOT NULL,source_generation INTEGER NOT NULL CHECK(source_generation>0),content_revision INTEGER NOT NULL CHECK(content_revision>0),
 initial INTEGER NOT NULL DEFAULT 0 CHECK(initial IN (0,1)),baseline_required INTEGER GENERATED ALWAYS AS (CASE WHEN initial=1 THEN 1 ELSE NULL END) STORED,before_commit TEXT,after_commit TEXT NOT NULL,inventory_hash TEXT NOT NULL CHECK(length(inventory_hash)=64),
 trigger_plan JSON NOT NULL DEFAULT '[]' CHECK(json_valid(trigger_plan) AND json_type(trigger_plan)='array'),
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','DISPATCHED','RETRY','DEAD','CANCELLED')),
 attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 owner_token TEXT,claimed_at TEXT,claim_expires_at TEXT,last_error_code TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,dispatched_at TEXT,
 FOREIGN KEY(sync_run_id,workspace_id) REFERENCES WorkspaceSyncRuns(id,workspace_id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,baseline_required) REFERENCES GitWorkspaces(workspace_id,baseline_established) DEFERRABLE INITIALLY DEFERRED,
 UNIQUE(workspace_id,source_generation,after_commit),UNIQUE(sync_run_id),UNIQUE(id,workspace_id),CHECK(id=sync_run_id),
 CHECK(status<>'PROCESSING' OR (owner_token IS NOT NULL AND claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL))
);
CREATE INDEX workspace_update_outbox_due ON WorkspaceUpdateOutbox(status,next_attempt_at,id);
CREATE TABLE TriggerEvents (
 id INTEGER PRIMARY KEY AUTOINCREMENT,trigger_id INTEGER REFERENCES TaskTriggers(id) ON DELETE SET NULL,
 origin_trigger_id INTEGER NOT NULL,task_id INTEGER REFERENCES Tasks(id) ON DELETE SET NULL,
 workspace_id INTEGER NOT NULL REFERENCES Workspaces(id) ON DELETE RESTRICT,
 workspace_update_id INTEGER REFERENCES WorkspaceUpdateOutbox(id) ON DELETE RESTRICT,
 event_key TEXT NOT NULL,trigger_type TEXT NOT NULL CHECK(trigger_type IN ('CRON','WEBHOOK','GIT_UPDATE')),
 status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK(status IN ('RECEIVED','PROCESSING','SUBMITTED','SKIPPED','FAILED')),
 task_run_id INTEGER UNIQUE REFERENCES TaskRuns(id) ON DELETE SET NULL,error_code TEXT,
 owner_token TEXT,claimed_at TEXT,claim_expires_at TEXT,attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),next_attempt_at TEXT,
 metadata JSON NOT NULL DEFAULT '{}' CHECK(json_valid(metadata)),received_at TEXT NOT NULL,
 createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(origin_trigger_id,event_key),CHECK((trigger_type='GIT_UPDATE')=(workspace_update_id IS NOT NULL)),
 CHECK(status<>'PROCESSING' OR (owner_token IS NOT NULL AND claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL))
);
CREATE INDEX trigger_events_status_id ON TriggerEvents(status,id);
CREATE INDEX trigger_events_task_id_id ON TriggerEvents(task_id,id);
CREATE TABLE TaskRuns (
 id INTEGER PRIMARY KEY AUTOINCREMENT,task_id INTEGER REFERENCES Tasks(id) ON DELETE SET NULL,
 workspace_id INTEGER NOT NULL REFERENCES Workspaces(id) ON DELETE RESTRICT,
 active_workspace_id INTEGER REFERENCES Workspaces(id) ON DELETE RESTRICT,
 result JSON CHECK(result IS NULL OR json_valid(result)),task_definition_version INTEGER,
 expected_workspace_version INTEGER NOT NULL CHECK(expected_workspace_version>0),
 expected_global_env_version INTEGER NOT NULL CHECK(expected_global_env_version>0),
 expected_task_definition_version INTEGER NOT NULL CHECK(expected_task_definition_version>0),
 expected_source_generation INTEGER NOT NULL CHECK(expected_source_generation>0),expected_content_revision INTEGER NOT NULL CHECK(expected_content_revision>0),
 expected_git_commit TEXT,expected_inventory_hash TEXT NOT NULL CHECK(length(expected_inventory_hash)=64 AND expected_inventory_hash NOT GLOB '*[^0-9a-f]*'),
 admission_snapshot JSON NOT NULL CHECK(json_valid(admission_snapshot) AND json_type(admission_snapshot)='object'),
 source_snapshot JSON CHECK(source_snapshot IS NULL OR (json_valid(source_snapshot) AND json_type(source_snapshot)='object')),
 trigger_type TEXT NOT NULL CHECK(trigger_type IN ('MANUAL','SCHEDULE','API','INTERNAL','CRON','WEBHOOK','GIT_UPDATE')),
 trigger_id INTEGER REFERENCES TaskTriggers(id) ON DELETE SET NULL,event_id INTEGER REFERENCES TriggerEvents(id) ON DELETE SET NULL,submission_key TEXT UNIQUE,
 status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','RESOLVING','RUNNING','SUCCESS','FAILED','TIMEOUT','CANCELLED','INTERRUPTED','SKIPPED','RECOVERY_REQUIRED')),
 submitted_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
 log_identity TEXT NOT NULL UNIQUE,result_code TEXT,exit_code INTEGER,signal TEXT,error_code TEXT,error_summary TEXT,
 snapshot_metadata JSON CHECK(snapshot_metadata IS NULL OR json_valid(snapshot_metadata)),
 concurrency_policy TEXT NOT NULL CHECK(concurrency_policy IN ('FORBID','QUEUE','ALLOW')),
 wait_mode TEXT NOT NULL DEFAULT 'WAIT' CHECK(wait_mode IN ('WAIT','SKIP','FAIL_FAST')),
 queue_reason TEXT NOT NULL DEFAULT 'NONE' CHECK(queue_reason IN ('NONE','TASK_CONCURRENCY','WORKSPACE_LEASE','PLATFORM_QUIESCING','RUNTIME_CAPACITY')),
 queue_deadline_at TEXT NOT NULL,next_eligible_at TEXT NOT NULL,queue_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(queue_attempt_count>=0),owner_token TEXT,
 log_size INTEGER NOT NULL DEFAULT 0 CHECK(log_size>=0),last_log_at TEXT,log_truncated INTEGER NOT NULL DEFAULT 0 CHECK(log_truncated IN (0,1)),
 createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(active_workspace_id IS NULL OR active_workspace_id=workspace_id),
 CHECK(status NOT IN ('QUEUED','RESOLVING','RUNNING','RECOVERY_REQUIRED') OR task_id IS NOT NULL),
 CHECK(status NOT IN ('SUCCESS','FAILED','TIMEOUT','CANCELLED','INTERRUPTED','SKIPPED') OR (finished_at IS NOT NULL AND active_workspace_id IS NULL)),
 CHECK(status<>'QUEUED' OR (active_workspace_id IS NULL AND owner_token IS NULL)),
 CHECK(status<>'RESOLVING' OR owner_token IS NOT NULL),
 CHECK(status<>'RUNNING' OR (source_snapshot IS NOT NULL AND active_workspace_id IS NOT NULL AND active_workspace_id=workspace_id AND owner_token IS NOT NULL)),
 CHECK(COALESCE(json_extract(admission_snapshot,'$.workspace_id')=workspace_id,0)),
 CHECK(expected_git_commit IS NULL OR (length(expected_git_commit) IN (40,64) AND expected_git_commit NOT GLOB '*[^0-9a-f]*'))
);
CREATE INDEX task_runs_status_id ON TaskRuns(status,id);
CREATE INDEX task_runs_task_id_status_id ON TaskRuns(task_id,status,id);
CREATE INDEX task_runs_workspace_queue ON TaskRuns(workspace_id,status,submitted_at,id);
CREATE INDEX task_runs_queue_due ON TaskRuns(status,next_eligible_at,submitted_at,id);
-- At most one active execution owner per Workspace; durable QUEUED rows are not OS-lease holders.
CREATE UNIQUE INDEX task_runs_workspace_active ON TaskRuns(active_workspace_id) WHERE active_workspace_id IS NOT NULL;

CREATE TABLE GlobalEnvironmentRevision (singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),version INTEGER NOT NULL DEFAULT 1 CHECK(version>0));
INSERT INTO GlobalEnvironmentRevision(singleton_id,version) VALUES(1,1);
CREATE TABLE WorkspacePreservationHolds (
 id INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id INTEGER NOT NULL REFERENCES Workspaces(id) ON DELETE RESTRICT,
 snapshot_key TEXT NOT NULL,source_generation INTEGER NOT NULL CHECK(source_generation>0),content_revision INTEGER NOT NULL CHECK(content_revision>0),
 inventory_hash TEXT NOT NULL CHECK(length(inventory_hash)=64 AND inventory_hash NOT GLOB '*[^0-9a-f]*'),manifest_hash TEXT NOT NULL CHECK(length(manifest_hash)=64),
 receipt JSON NOT NULL CHECK(json_valid(receipt)),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,released_at TEXT,
 UNIQUE(workspace_id,snapshot_key),UNIQUE(id,workspace_id)
);
CREATE INDEX workspace_preservation_active ON WorkspacePreservationHolds(workspace_id,source_generation,content_revision,inventory_hash) WHERE released_at IS NULL;
-- Cross-table lifecycle invariants. CREATING is never a ready/readable/runnable state.
CREATE TRIGGER workspace_initial_state BEFORE INSERT ON Workspaces
WHEN NEW.lifecycle_state<>'CREATING' OR NEW.storage_state<>'PROVISIONING'
BEGIN SELECT RAISE(ABORT,'WORKSPACE_NOT_READY'); END;
CREATE TRIGGER workspace_identity_immutable BEFORE UPDATE ON Workspaces
WHEN NEW.id<>OLD.id OR NEW.type<>OLD.type OR NEW.source_generation<>OLD.source_generation
BEGIN SELECT RAISE(ABORT,'WORKSPACE_TYPE_INVALID'); END;
CREATE TRIGGER workspace_state_transition BEFORE UPDATE OF lifecycle_state ON Workspaces
WHEN NEW.lifecycle_state<>OLD.lifecycle_state AND NOT (
 (OLD.lifecycle_state='CREATING' AND NEW.lifecycle_state IN ('READY','ERROR','RECOVERY_REQUIRED','DELETE_REQUESTED')) OR
 (OLD.lifecycle_state='READY' AND NEW.lifecycle_state IN ('ARCHIVED','DELETE_REQUESTED','RECOVERY_REQUIRED')) OR
 (OLD.lifecycle_state='ARCHIVED' AND NEW.lifecycle_state IN ('READY','DELETE_REQUESTED','RECOVERY_REQUIRED')) OR
 (OLD.lifecycle_state='ERROR' AND NEW.lifecycle_state IN ('CREATING','RECOVERY_REQUIRED','DELETE_REQUESTED')) OR
 (OLD.lifecycle_state='RECOVERY_REQUIRED' AND NEW.lifecycle_state IN ('READY','ARCHIVED','ERROR','CREATING','DELETE_REQUESTED','TOMBSTONED')) OR
 (OLD.lifecycle_state='DELETE_REQUESTED' AND NEW.lifecycle_state IN ('TOMBSTONED','RECOVERY_REQUIRED')))
BEGIN SELECT RAISE(ABORT,'WORKSPACE_NOT_READY'); END;
CREATE TRIGGER workspace_git_ready_guard BEFORE UPDATE ON Workspaces
WHEN NEW.lifecycle_state IN ('READY','ARCHIVED') AND NEW.type='GIT' AND NOT EXISTS(
 SELECT 1 FROM GitWorkspaces g WHERE g.workspace_id=NEW.id AND g.repository_id IS NOT NULL AND g.last_verified_commit IS NOT NULL AND g.applied_commit IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'WORKSPACE_NOT_READY'); END;
CREATE TRIGGER git_workspace_immutable BEFORE UPDATE ON GitWorkspaces
WHEN NEW.workspace_id<>OLD.workspace_id OR NEW.repository_id<>OLD.repository_id OR NEW.ref_type<>OLD.ref_type OR NEW.ref_name<>OLD.ref_name OR NEW.private_branch IS NOT OLD.private_branch OR NEW.resolved_commit<>OLD.resolved_commit
BEGIN SELECT RAISE(ABORT,'WORKSPACE_TYPE_INVALID'); END;
CREATE TRIGGER git_workspace_pin_guard BEFORE UPDATE ON GitWorkspaces
WHEN NEW.ref_type IN ('tag','commit') AND (NEW.applied_commit IS NOT NULL AND NEW.applied_commit<>NEW.resolved_commit OR NEW.last_verified_commit IS NOT NULL AND NEW.last_verified_commit<>NEW.resolved_commit)
BEGIN SELECT RAISE(ABORT,'GIT_REF_POLICY_INVALID'); END;
CREATE TRIGGER git_workspace_delete_guard BEFORE DELETE ON GitWorkspaces
WHEN EXISTS(SELECT 1 FROM Workspaces WHERE id=OLD.workspace_id AND (lifecycle_state<>'TOMBSTONED' OR storage_state<>'RECLAIMED'))
BEGIN SELECT RAISE(ABORT,'WORKSPACE_REFERENCED'); END;
CREATE TRIGGER workspace_delete_request_guard BEFORE UPDATE OF lifecycle_state ON Workspaces
WHEN NEW.lifecycle_state='DELETE_REQUESTED' AND (
 EXISTS(SELECT 1 FROM TaskSources WHERE workspace_id=NEW.id) OR
 EXISTS(SELECT 1 FROM TaskRuns WHERE workspace_id=NEW.id AND status IN ('QUEUED','RESOLVING','RUNNING','RECOVERY_REQUIRED')) OR
 EXISTS(SELECT 1 FROM WorkspaceSyncRuns WHERE workspace_id=NEW.id AND status IN ('QUEUED','RUNNING','RECOVERY_REQUIRED')) OR
 EXISTS(SELECT 1 FROM WorkspaceUpdateOutbox WHERE workspace_id=NEW.id AND status IN ('PENDING','PROCESSING','RETRY')) OR
 EXISTS(SELECT 1 FROM TriggerEvents WHERE workspace_id=NEW.id AND status IN ('RECEIVED','PROCESSING')))
BEGIN SELECT RAISE(ABORT,'WORKSPACE_REFERENCED'); END;
CREATE TRIGGER workspace_reclaim_guard BEFORE UPDATE OF storage_state ON Workspaces
WHEN NEW.storage_state='RECLAIMING' AND (
 NEW.lifecycle_state<>'DELETE_REQUESTED' OR
 EXISTS(SELECT 1 FROM TaskSources WHERE workspace_id=NEW.id) OR
 EXISTS(SELECT 1 FROM TaskRuns WHERE active_workspace_id=NEW.id OR (workspace_id=NEW.id AND status IN ('QUEUED','RESOLVING','RUNNING','RECOVERY_REQUIRED'))) OR
 EXISTS(SELECT 1 FROM WorkspaceSyncRuns WHERE workspace_id=NEW.id AND status IN ('QUEUED','RUNNING','RECOVERY_REQUIRED')) OR
 ((NEW.type='GIT' OR NEW.file_count>0) AND NOT EXISTS(SELECT 1 FROM WorkspacePreservationHolds h WHERE h.workspace_id=NEW.id AND h.released_at IS NULL AND h.source_generation=NEW.source_generation AND h.content_revision=NEW.content_revision AND h.inventory_hash=NEW.content_inventory_hash)))
BEGIN SELECT RAISE(ABORT,'WORKSPACE_REFERENCED'); END;
CREATE TRIGGER workspace_metadata_delete_guard BEFORE DELETE ON Workspaces
WHEN OLD.lifecycle_state<>'TOMBSTONED' OR OLD.storage_state<>'RECLAIMED'
BEGIN SELECT RAISE(ABORT,'WORKSPACE_REFERENCED'); END;
CREATE TRIGGER workspace_content_version_guard BEFORE UPDATE ON Workspaces
WHEN (OLD.content_inventory_hash IS NOT NULL AND NEW.content_inventory_hash IS NOT OLD.content_inventory_hash AND NEW.content_revision<=OLD.content_revision) OR NEW.content_revision<OLD.content_revision OR NEW.version<OLD.version
BEGIN SELECT RAISE(ABORT,'WORKSPACE_VERSION_CONFLICT'); END;
CREATE TRIGGER task_workspace_insert_guard BEFORE INSERT ON Tasks
WHEN NOT EXISTS(SELECT 1 FROM Workspaces w WHERE w.id=NEW.workspace_id AND w.lifecycle_state='READY' AND w.storage_state='PRESENT') OR EXISTS(SELECT 1 FROM WorkspaceOperations o WHERE o.workspace_id=NEW.workspace_id AND o.status IN ('PENDING','RUNNING','DRAINING','RECOVERY_REQUIRED'))
BEGIN SELECT RAISE(ABORT,'WORKSPACE_NOT_READY'); END;
CREATE TRIGGER task_discovery_insert_guard BEFORE INSERT ON Tasks
WHEN NEW.origin='DISCOVERED' AND (NOT EXISTS(SELECT 1 FROM GitWorkspaces WHERE workspace_id=NEW.workspace_id) OR EXISTS(SELECT 1 FROM WorkspaceDiscoverySuppressions WHERE workspace_id=NEW.workspace_id AND discovery_key=NEW.discovery_key))
BEGIN SELECT RAISE(ABORT,'TASK_IDENTITY_INVALID'); END;
CREATE TRIGGER task_identity_immutable BEFORE UPDATE ON Tasks
WHEN NEW.id<>OLD.id OR NEW.origin<>OLD.origin OR NEW.discovered_workspace_id IS NOT OLD.discovered_workspace_id OR NEW.discovery_key IS NOT OLD.discovery_key OR (OLD.origin='DISCOVERED' AND NEW.workspace_id<>OLD.workspace_id)
BEGIN SELECT RAISE(ABORT,'TASK_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER task_workspace_update_guard BEFORE UPDATE OF workspace_id ON Tasks
WHEN NEW.workspace_id<>OLD.workspace_id AND NOT EXISTS(SELECT 1 FROM Workspaces WHERE id=NEW.workspace_id AND lifecycle_state='READY' AND storage_state='PRESENT')
BEGIN SELECT RAISE(ABORT,'WORKSPACE_NOT_READY'); END;
CREATE TRIGGER task_active_run_delete_guard BEFORE DELETE ON Tasks
WHEN EXISTS(SELECT 1 FROM TaskRuns WHERE task_id=OLD.id AND status IN ('QUEUED','RESOLVING','RUNNING','RECOVERY_REQUIRED'))
BEGIN SELECT RAISE(ABORT,'TASK_ACTIVE_RUN'); END;
CREATE TRIGGER task_source_active_guard BEFORE UPDATE ON TaskSources
WHEN EXISTS(SELECT 1 FROM TaskRuns WHERE task_id=OLD.task_id AND status IN ('RESOLVING','RUNNING','RECOVERY_REQUIRED'))
BEGIN SELECT RAISE(ABORT,'TASK_ACTIVE_RUN'); END;
CREATE TRIGGER task_run_admission_guard BEFORE INSERT ON TaskRuns
WHEN NEW.status IN ('QUEUED','RESOLVING','RUNNING') AND (
 NOT EXISTS(SELECT 1 FROM Tasks t JOIN Workspaces w ON w.id=t.workspace_id WHERE t.id=NEW.task_id AND t.workspace_id=NEW.workspace_id AND w.lifecycle_state='READY' AND w.storage_state='PRESENT') OR
 EXISTS(SELECT 1 FROM WorkspaceOperations o WHERE o.workspace_id=NEW.workspace_id AND o.status IN ('PENDING','RUNNING','DRAINING','RECOVERY_REQUIRED')) OR EXISTS(SELECT 1 FROM WorkspaceSyncRuns WHERE workspace_id=NEW.workspace_id AND status='RECOVERY_REQUIRED'))
BEGIN SELECT RAISE(ABORT,'WORKSPACE_NOT_READY'); END;
CREATE TRIGGER task_run_expectation_immutable BEFORE UPDATE ON TaskRuns
WHEN NEW.workspace_id<>OLD.workspace_id OR NEW.expected_workspace_version<>OLD.expected_workspace_version OR NEW.expected_global_env_version<>OLD.expected_global_env_version OR NEW.expected_task_definition_version<>OLD.expected_task_definition_version OR NEW.expected_source_generation<>OLD.expected_source_generation OR NEW.expected_content_revision<>OLD.expected_content_revision OR NEW.expected_git_commit IS NOT OLD.expected_git_commit OR NEW.expected_inventory_hash<>OLD.expected_inventory_hash OR NEW.admission_snapshot<>OLD.admission_snapshot OR NEW.submitted_at<>OLD.submitted_at OR NEW.queue_deadline_at<>OLD.queue_deadline_at OR NEW.submission_key IS NOT OLD.submission_key
BEGIN SELECT RAISE(ABORT,'SOURCE_SUPERSEDED'); END;
CREATE TRIGGER task_run_snapshot_immutable BEFORE UPDATE ON TaskRuns
WHEN OLD.source_snapshot IS NOT NULL AND NEW.source_snapshot IS NOT OLD.source_snapshot
BEGIN SELECT RAISE(ABORT,'SOURCE_SUPERSEDED'); END;
CREATE TRIGGER task_run_execution_snapshot_immutable BEFORE UPDATE ON TaskRuns
WHEN OLD.snapshot_metadata IS NOT NULL AND NEW.snapshot_metadata IS NOT OLD.snapshot_metadata
BEGIN SELECT RAISE(ABORT,'SOURCE_SUPERSEDED'); END;
CREATE TRIGGER task_run_state_transition BEFORE UPDATE OF status ON TaskRuns
WHEN NEW.status<>OLD.status AND NOT(
 (OLD.status='QUEUED' AND NEW.status IN ('RESOLVING','CANCELLED','SKIPPED')) OR
 (OLD.status='RESOLVING' AND NEW.status IN ('RUNNING','QUEUED','FAILED','CANCELLED','INTERRUPTED','SKIPPED','RECOVERY_REQUIRED')) OR
 (OLD.status='RUNNING' AND NEW.status IN ('SUCCESS','FAILED','TIMEOUT','CANCELLED','INTERRUPTED','RECOVERY_REQUIRED')) OR
 (OLD.status='RECOVERY_REQUIRED' AND NEW.status='INTERRUPTED'))
BEGIN SELECT RAISE(ABORT,'TASK_RUN_STATUS_INVALID'); END;
CREATE TRIGGER task_run_event_identity_insert BEFORE INSERT ON TaskRuns
WHEN NEW.event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM TriggerEvents e WHERE e.id=NEW.event_id AND e.task_id=NEW.task_id AND e.trigger_id IS NEW.trigger_id AND e.trigger_type=NEW.trigger_type AND e.workspace_id=NEW.workspace_id AND NEW.submission_key='event:'||e.id)
BEGIN SELECT RAISE(ABORT,'TASK_RUN_EVENT_IDENTITY_INVALID'); END;
CREATE TRIGGER task_git_trigger_insert_guard BEFORE INSERT ON GitUpdateTriggers
WHEN NOT EXISTS(SELECT 1 FROM TaskTriggers tr JOIN Tasks t ON t.id=tr.task_id JOIN GitWorkspaces g ON g.workspace_id=t.workspace_id WHERE tr.id=NEW.trigger_id AND tr.type='GIT_UPDATE')
BEGIN SELECT RAISE(ABORT,'WORKSPACE_TYPE_INVALID'); END;
CREATE TRIGGER sync_policy_branch_insert BEFORE INSERT ON WorkspaceSyncPolicies
WHEN NEW.update_mode='SCHEDULED' AND NOT EXISTS(SELECT 1 FROM GitWorkspaces WHERE workspace_id=NEW.workspace_id AND ref_type='branch')
BEGIN SELECT RAISE(ABORT,'SYNC_POLICY_INVALID'); END;
CREATE TRIGGER sync_policy_branch_update BEFORE UPDATE ON WorkspaceSyncPolicies
WHEN NEW.update_mode='SCHEDULED' AND NOT EXISTS(SELECT 1 FROM GitWorkspaces WHERE workspace_id=NEW.workspace_id AND ref_type='branch')
BEGIN SELECT RAISE(ABORT,'SYNC_POLICY_INVALID'); END;
CREATE TRIGGER sync_run_git_insert BEFORE INSERT ON WorkspaceSyncRuns
WHEN NOT EXISTS(SELECT 1 FROM GitWorkspaces WHERE workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'WORKSPACE_TYPE_INVALID'); END;
CREATE TRIGGER sync_run_state_transition BEFORE UPDATE OF status ON WorkspaceSyncRuns
WHEN NEW.status<>OLD.status AND NOT(
 (OLD.status='QUEUED' AND NEW.status IN ('RUNNING','BLOCKED','CANCELLED','INTERRUPTED')) OR
 (OLD.status='RUNNING' AND NEW.status IN ('NO_CHANGE','SUCCESS','BLOCKED','FAILED','RECOVERY_REQUIRED','CANCELLED','INTERRUPTED')) OR
 (OLD.status='RECOVERY_REQUIRED' AND NEW.status='RUNNING'))
BEGIN SELECT RAISE(ABORT,'SYNC_RECOVERY_REQUIRED'); END;
CREATE TRIGGER sync_run_identity_immutable BEFORE UPDATE ON WorkspaceSyncRuns
WHEN NEW.workspace_id<>OLD.workspace_id OR NEW.request_key<>OLD.request_key OR NEW.request_hash<>OLD.request_hash OR NEW.source_generation<>OLD.source_generation OR NEW.policy_version<>OLD.policy_version OR NEW.initial<>OLD.initial OR NEW.source_snapshot<>OLD.source_snapshot
BEGIN SELECT RAISE(ABORT,'SYNC_POLICY_INVALID'); END;
CREATE TRIGGER sync_run_terminal_facts_immutable BEFORE UPDATE ON WorkspaceSyncRuns
WHEN OLD.status IN ('NO_CHANGE','SUCCESS','BLOCKED','FAILED','CANCELLED','INTERRUPTED') AND (NEW.status<>OLD.status OR NEW.before_commit IS NOT OLD.before_commit OR NEW.target_commit IS NOT OLD.target_commit OR NEW.actual_commit IS NOT OLD.actual_commit OR NEW.after_commit IS NOT OLD.after_commit OR NEW.git_update_status<>OLD.git_update_status OR NEW.discovery_status<>OLD.discovery_status OR NEW.content_revision IS NOT OLD.content_revision OR NEW.update_outbox_id IS NOT OLD.update_outbox_id)
BEGIN SELECT RAISE(ABORT,'SYNC_RECOVERY_REQUIRED'); END;
CREATE TRIGGER workspace_update_success_guard BEFORE INSERT ON WorkspaceUpdateOutbox
WHEN NOT EXISTS(SELECT 1 FROM WorkspaceSyncRuns r JOIN Workspaces w ON w.id=r.workspace_id JOIN GitWorkspaces g ON g.workspace_id=w.id
 WHERE r.id=NEW.sync_run_id AND r.workspace_id=NEW.workspace_id AND r.status='SUCCESS' AND r.update_outbox_id=NEW.id AND r.source_generation=NEW.source_generation AND r.content_revision=NEW.content_revision AND r.actual_commit=NEW.after_commit AND r.after_commit=NEW.after_commit AND r.before_commit IS NEW.before_commit AND r.discovery_status IN ('NOT_REQUESTED','SUCCESS') AND (r.git_update_status='APPLIED' OR (r.initial=1 AND r.git_update_status='UNCHANGED' AND r.before_commit=r.actual_commit)) AND r.initial=NEW.initial AND (NEW.initial=0 AND g.baseline_established=1 OR NEW.initial=1 AND g.baseline_established=0) AND w.content_revision=NEW.content_revision AND w.content_inventory_hash=NEW.inventory_hash AND g.applied_commit=NEW.after_commit)
BEGIN SELECT RAISE(ABORT,'SYNC_RECOVERY_REQUIRED'); END;
CREATE TRIGGER workspace_update_identity_immutable BEFORE UPDATE ON WorkspaceUpdateOutbox
WHEN NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id OR NEW.sync_run_id<>OLD.sync_run_id OR NEW.source_generation<>OLD.source_generation OR NEW.content_revision<>OLD.content_revision OR NEW.initial<>OLD.initial OR NEW.before_commit IS NOT OLD.before_commit OR NEW.after_commit<>OLD.after_commit OR NEW.inventory_hash<>OLD.inventory_hash OR NEW.trigger_plan<>OLD.trigger_plan
BEGIN SELECT RAISE(ABORT,'SYNC_RECOVERY_REQUIRED'); END;
CREATE TRIGGER workspace_update_state_transition BEFORE UPDATE OF status ON WorkspaceUpdateOutbox
WHEN NEW.status<>OLD.status AND NOT(
 (OLD.status IN ('PENDING','RETRY') AND NEW.status IN ('PROCESSING','CANCELLED')) OR
 (OLD.status='PROCESSING' AND NEW.status IN ('RETRY','DISPATCHED','DEAD','CANCELLED')))
BEGIN SELECT RAISE(ABORT,'SYNC_RECOVERY_REQUIRED'); END;
CREATE TRIGGER git_update_event_committed_guard BEFORE INSERT ON TriggerEvents
WHEN NEW.trigger_type='GIT_UPDATE' AND NOT EXISTS(SELECT 1 FROM WorkspaceUpdateOutbox o JOIN WorkspaceSyncRuns r ON r.id=o.sync_run_id WHERE o.id=NEW.workspace_update_id AND o.workspace_id=NEW.workspace_id AND r.status='SUCCESS' AND o.status IN ('PENDING','PROCESSING','RETRY','DISPATCHED'))
BEGIN SELECT RAISE(ABORT,'SYNC_RECOVERY_REQUIRED'); END;
CREATE TRIGGER trigger_event_origin_guard BEFORE INSERT ON TriggerEvents
WHEN NEW.trigger_id IS NULL OR NEW.origin_trigger_id<>NEW.trigger_id OR NOT EXISTS(SELECT 1 FROM TaskTriggers tr JOIN Tasks t ON t.id=tr.task_id WHERE tr.id=NEW.trigger_id AND tr.task_id=NEW.task_id AND tr.type=NEW.trigger_type AND t.workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'TRIGGER_EVENT_INVALID'); END;
CREATE TRIGGER trigger_event_origin_immutable BEFORE UPDATE ON TriggerEvents
WHEN NEW.origin_trigger_id<>OLD.origin_trigger_id OR NEW.workspace_id<>OLD.workspace_id OR NEW.event_key<>OLD.event_key OR NEW.trigger_type<>OLD.trigger_type OR NEW.workspace_update_id IS NOT OLD.workspace_update_id
BEGIN SELECT RAISE(ABORT,'TRIGGER_EVENT_INVALID'); END;
CREATE TRIGGER preservation_hold_immutable BEFORE UPDATE ON WorkspacePreservationHolds
WHEN NEW.workspace_id<>OLD.workspace_id OR NEW.snapshot_key<>OLD.snapshot_key OR NEW.source_generation<>OLD.source_generation OR NEW.content_revision<>OLD.content_revision OR NEW.inventory_hash<>OLD.inventory_hash OR NEW.manifest_hash<>OLD.manifest_hash OR NEW.receipt<>OLD.receipt
BEGIN SELECT RAISE(ABORT,'WORKSPACE_REFERENCED'); END;

CREATE TRIGGER s0_tasksources_definition_insert AFTER INSERT ON TaskSources BEGIN UPDATE Tasks SET version=version+1 WHERE id=NEW.task_id; END;

CREATE TRIGGER s0_tasksources_definition_update AFTER UPDATE ON TaskSources BEGIN UPDATE Tasks SET version=version+1 WHERE id=NEW.task_id; END;

CREATE TRIGGER s0_tasksources_definition_delete AFTER DELETE ON TaskSources BEGIN UPDATE Tasks SET version=version+1 WHERE id=OLD.task_id; END;

CREATE TRIGGER s0_taskruntimebindings_definition_insert AFTER INSERT ON TaskRuntimeBindings BEGIN UPDATE Tasks SET version=version+1 WHERE id=NEW.task_id; END;

CREATE TRIGGER s0_taskruntimebindings_definition_update AFTER UPDATE ON TaskRuntimeBindings BEGIN UPDATE Tasks SET version=version+1 WHERE id=NEW.task_id; END;

CREATE TRIGGER s0_taskruntimebindings_definition_delete AFTER DELETE ON TaskRuntimeBindings BEGIN UPDATE Tasks SET version=version+1 WHERE id=OLD.task_id; END;

CREATE TRIGGER s0_taskexecutionsettings_definition_insert AFTER INSERT ON TaskExecutionSettings BEGIN UPDATE Tasks SET version=version+1 WHERE id=NEW.task_id; END;

CREATE TRIGGER s0_taskexecutionsettings_definition_update AFTER UPDATE ON TaskExecutionSettings BEGIN UPDATE Tasks SET version=version+1 WHERE id=NEW.task_id; END;

CREATE TRIGGER s0_taskexecutionsettings_definition_delete AFTER DELETE ON TaskExecutionSettings BEGIN UPDATE Tasks SET version=version+1 WHERE id=OLD.task_id; END;

CREATE TRIGGER s0_taskenvvariables_definition_insert AFTER INSERT ON TaskEnvVariables BEGIN UPDATE Tasks SET version=version+1 WHERE id=NEW.task_id; END;

CREATE TRIGGER s0_taskenvvariables_definition_update AFTER UPDATE ON TaskEnvVariables BEGIN UPDATE Tasks SET version=version+1 WHERE id=NEW.task_id; END;

CREATE TRIGGER s0_taskenvvariables_definition_delete AFTER DELETE ON TaskEnvVariables BEGIN UPDATE Tasks SET version=version+1 WHERE id=OLD.task_id; END;

CREATE TRIGGER s0_taskconfigbindings_definition_insert AFTER INSERT ON TaskConfigBindings BEGIN UPDATE Tasks SET version=version+1 WHERE id=NEW.task_id; END;

CREATE TRIGGER s0_taskconfigbindings_definition_update AFTER UPDATE ON TaskConfigBindings BEGIN UPDATE Tasks SET version=version+1 WHERE id=NEW.task_id; END;

CREATE TRIGGER s0_taskconfigbindings_definition_delete AFTER DELETE ON TaskConfigBindings BEGIN UPDATE Tasks SET version=version+1 WHERE id=OLD.task_id; END;

CREATE TRIGGER s0_taskhooks_definition_insert AFTER INSERT ON TaskHooks BEGIN UPDATE Tasks SET version=version+1 WHERE id=NEW.task_id; END;

CREATE TRIGGER s0_taskhooks_definition_update AFTER UPDATE ON TaskHooks BEGIN UPDATE Tasks SET version=version+1 WHERE id=NEW.task_id; END;

CREATE TRIGGER s0_taskhooks_definition_delete AFTER DELETE ON TaskHooks BEGIN UPDATE Tasks SET version=version+1 WHERE id=OLD.task_id; END;

CREATE TRIGGER s0_tasktriggers_definition_insert AFTER INSERT ON TaskTriggers BEGIN UPDATE Tasks SET version=version+1 WHERE id=NEW.task_id; END;

CREATE TRIGGER s0_tasktriggers_definition_update AFTER UPDATE ON TaskTriggers BEGIN UPDATE Tasks SET version=version+1 WHERE id=NEW.task_id; END;

CREATE TRIGGER s0_tasktriggers_definition_delete AFTER DELETE ON TaskTriggers BEGIN UPDATE Tasks SET version=version+1 WHERE id=OLD.task_id; END;

CREATE TRIGGER s0_tasknotificationpolicies_definition_insert AFTER INSERT ON TaskNotificationPolicies BEGIN UPDATE Tasks SET version=version+1 WHERE id=NEW.task_id; END;

CREATE TRIGGER s0_tasknotificationpolicies_definition_update AFTER UPDATE ON TaskNotificationPolicies BEGIN UPDATE Tasks SET version=version+1 WHERE id=NEW.task_id; END;

CREATE TRIGGER s0_tasknotificationpolicies_definition_delete AFTER DELETE ON TaskNotificationPolicies BEGIN UPDATE Tasks SET version=version+1 WHERE id=OLD.task_id; END;

CREATE TRIGGER s0_tasknotificationchannelbindings_definition_insert AFTER INSERT ON TaskNotificationChannelBindings BEGIN UPDATE Tasks SET version=version+1 WHERE id=NEW.task_id; END;

CREATE TRIGGER s0_tasknotificationchannelbindings_definition_update AFTER UPDATE ON TaskNotificationChannelBindings BEGIN UPDATE Tasks SET version=version+1 WHERE id=NEW.task_id; END;

CREATE TRIGGER s0_tasknotificationchannelbindings_definition_delete AFTER DELETE ON TaskNotificationChannelBindings BEGIN UPDATE Tasks SET version=version+1 WHERE id=OLD.task_id; END;

CREATE TRIGGER s0_environmentprofiles_workspace_insert AFTER INSERT ON EnvironmentProfiles BEGIN UPDATE Workspaces SET version=version+1 WHERE id=NEW.workspace_id; END;

CREATE TRIGGER s0_environmentprofiles_workspace_update AFTER UPDATE ON EnvironmentProfiles BEGIN UPDATE Workspaces SET version=version+1 WHERE id=NEW.workspace_id; END;

CREATE TRIGGER s0_environmentprofiles_workspace_delete AFTER DELETE ON EnvironmentProfiles BEGIN UPDATE Workspaces SET version=version+1 WHERE id=OLD.workspace_id; END;

CREATE TRIGGER s0_workspaceruntimedefaults_workspace_insert AFTER INSERT ON WorkspaceRuntimeDefaults BEGIN UPDATE Workspaces SET version=version+1 WHERE id=NEW.workspace_id; END;

CREATE TRIGGER s0_workspaceruntimedefaults_workspace_update AFTER UPDATE ON WorkspaceRuntimeDefaults BEGIN UPDATE Workspaces SET version=version+1 WHERE id=NEW.workspace_id; END;

CREATE TRIGGER s0_workspaceruntimedefaults_workspace_delete AFTER DELETE ON WorkspaceRuntimeDefaults BEGIN UPDATE Workspaces SET version=version+1 WHERE id=OLD.workspace_id; END;

CREATE TRIGGER s0_workspaceconfigbindings_workspace_insert AFTER INSERT ON WorkspaceConfigBindings BEGIN UPDATE Workspaces SET version=version+1 WHERE id=NEW.workspace_id; END;

CREATE TRIGGER s0_workspaceconfigbindings_workspace_update AFTER UPDATE ON WorkspaceConfigBindings BEGIN UPDATE Workspaces SET version=version+1 WHERE id=NEW.workspace_id; END;

CREATE TRIGGER s0_workspaceconfigbindings_workspace_delete AFTER DELETE ON WorkspaceConfigBindings BEGIN UPDATE Workspaces SET version=version+1 WHERE id=OLD.workspace_id; END;

CREATE TRIGGER s0_profile_variables_workspace_insert AFTER INSERT ON WorkspaceProfileVariables BEGIN UPDATE EnvironmentProfiles SET version=version+1 WHERE id=NEW.profile_id; END;

CREATE TRIGGER s0_global_env_revision_insert AFTER INSERT ON Envs BEGIN UPDATE GlobalEnvironmentRevision SET version=version+1 WHERE singleton_id=1; END;

CREATE TRIGGER s0_profile_variables_workspace_update AFTER UPDATE ON WorkspaceProfileVariables BEGIN UPDATE EnvironmentProfiles SET version=version+1 WHERE id=NEW.profile_id; END;

CREATE TRIGGER s0_global_env_revision_update AFTER UPDATE ON Envs BEGIN UPDATE GlobalEnvironmentRevision SET version=version+1 WHERE singleton_id=1; END;

CREATE TRIGGER s0_profile_variables_workspace_delete AFTER DELETE ON WorkspaceProfileVariables BEGIN UPDATE EnvironmentProfiles SET version=version+1 WHERE id=OLD.profile_id; END;

CREATE TRIGGER s0_global_env_revision_delete AFTER DELETE ON Envs BEGIN UPDATE GlobalEnvironmentRevision SET version=version+1 WHERE singleton_id=1; END;

CREATE TRIGGER s0_taskruntimebindings_runtime_insert BEFORE INSERT ON TaskRuntimeBindings WHEN NEW.kind NOT IN ('SHELL','PYTHON','NODE') OR (NEW.kind<>'PYTHON' AND NEW.python_environment_id IS NOT NULL) OR (NEW.kind<>'NODE' AND NEW.node_environment_id IS NOT NULL) OR EXISTS(SELECT 1 FROM PythonEnvironments WHERE id=NEW.python_environment_id AND state='DELETING') OR EXISTS(SELECT 1 FROM NodeEnvironments WHERE id=NEW.node_environment_id AND state='DELETING') BEGIN SELECT RAISE(ABORT,'TASK_RUNTIME_BINDING_INVALID'); END;

CREATE TRIGGER s0_taskruntimebindings_runtime_update BEFORE UPDATE ON TaskRuntimeBindings WHEN NEW.kind NOT IN ('SHELL','PYTHON','NODE') OR (NEW.kind<>'PYTHON' AND NEW.python_environment_id IS NOT NULL) OR (NEW.kind<>'NODE' AND NEW.node_environment_id IS NOT NULL) OR EXISTS(SELECT 1 FROM PythonEnvironments WHERE id=NEW.python_environment_id AND state='DELETING') OR EXISTS(SELECT 1 FROM NodeEnvironments WHERE id=NEW.node_environment_id AND state='DELETING') BEGIN SELECT RAISE(ABORT,'TASK_RUNTIME_BINDING_INVALID'); END;

CREATE TRIGGER s0_workspaceruntimedefaults_runtime_insert BEFORE INSERT ON WorkspaceRuntimeDefaults WHEN NEW.kind NOT IN ('SHELL','PYTHON','NODE') OR (NEW.kind<>'PYTHON' AND NEW.python_environment_id IS NOT NULL) OR (NEW.kind<>'NODE' AND NEW.node_environment_id IS NOT NULL) OR EXISTS(SELECT 1 FROM PythonEnvironments WHERE id=NEW.python_environment_id AND state='DELETING') OR EXISTS(SELECT 1 FROM NodeEnvironments WHERE id=NEW.node_environment_id AND state='DELETING') BEGIN SELECT RAISE(ABORT,'TASK_RUNTIME_BINDING_INVALID'); END;

CREATE TRIGGER s0_workspaceruntimedefaults_runtime_update BEFORE UPDATE ON WorkspaceRuntimeDefaults WHEN NEW.kind NOT IN ('SHELL','PYTHON','NODE') OR (NEW.kind<>'PYTHON' AND NEW.python_environment_id IS NOT NULL) OR (NEW.kind<>'NODE' AND NEW.node_environment_id IS NOT NULL) OR EXISTS(SELECT 1 FROM PythonEnvironments WHERE id=NEW.python_environment_id AND state='DELETING') OR EXISTS(SELECT 1 FROM NodeEnvironments WHERE id=NEW.node_environment_id AND state='DELETING') BEGIN SELECT RAISE(ABORT,'TASK_RUNTIME_BINDING_INVALID'); END;

CREATE TRIGGER s0_pythonenvironments_reference_guard BEFORE UPDATE OF state ON PythonEnvironments WHEN NEW.state='DELETING' AND (EXISTS(SELECT 1 FROM TaskRuntimeBindings WHERE python_environment_id=NEW.id) OR EXISTS(SELECT 1 FROM WorkspaceRuntimeDefaults WHERE python_environment_id=NEW.id)) BEGIN SELECT RAISE(ABORT,'ENVIRONMENT_TASK_REFERENCED'); END;

CREATE TRIGGER s0_nodeenvironments_reference_guard BEFORE UPDATE OF state ON NodeEnvironments WHEN NEW.state='DELETING' AND (EXISTS(SELECT 1 FROM TaskRuntimeBindings WHERE node_environment_id=NEW.id) OR EXISTS(SELECT 1 FROM WorkspaceRuntimeDefaults WHERE node_environment_id=NEW.id)) BEGIN SELECT RAISE(ABORT,'ENVIRONMENT_TASK_REFERENCED'); END;

CREATE TRIGGER CronTriggers_kind_insert BEFORE INSERT ON CronTriggers WHEN NOT EXISTS(SELECT 1 FROM TaskTriggers WHERE id=NEW.trigger_id AND type='CRON') BEGIN SELECT RAISE(ABORT,'TRIGGER_CONFIG_KIND_INVALID'); END;

CREATE TRIGGER CronTriggers_kind_update BEFORE UPDATE ON CronTriggers WHEN NOT EXISTS(SELECT 1 FROM TaskTriggers WHERE id=NEW.trigger_id AND type='CRON') BEGIN SELECT RAISE(ABORT,'TRIGGER_CONFIG_KIND_INVALID'); END;

CREATE TRIGGER GitUpdateTriggers_kind_insert BEFORE INSERT ON GitUpdateTriggers WHEN NOT EXISTS(SELECT 1 FROM TaskTriggers WHERE id=NEW.trigger_id AND type='GIT_UPDATE') BEGIN SELECT RAISE(ABORT,'TRIGGER_CONFIG_KIND_INVALID'); END;

CREATE TRIGGER GitUpdateTriggers_kind_update BEFORE UPDATE ON GitUpdateTriggers WHEN NOT EXISTS(SELECT 1 FROM TaskTriggers WHERE id=NEW.trigger_id AND type='GIT_UPDATE') BEGIN SELECT RAISE(ABORT,'TRIGGER_CONFIG_KIND_INVALID'); END;

CREATE TRIGGER TaskRunAttempts_status_insert BEFORE INSERT ON TaskRunAttempts WHEN NEW.status NOT IN ('QUEUED','RESOLVING','RUNNING','SUCCESS','FAILED','TIMEOUT','CANCELLED','INTERRUPTED','SKIPPED','RECOVERY_REQUIRED') BEGIN SELECT RAISE(ABORT,'TASK_RUN_STATUS_INVALID'); END;

CREATE TRIGGER TaskRunAttempts_status_update BEFORE UPDATE ON TaskRunAttempts WHEN NEW.status NOT IN ('QUEUED','RESOLVING','RUNNING','SUCCESS','FAILED','TIMEOUT','CANCELLED','INTERRUPTED','SKIPPED','RECOVERY_REQUIRED') BEGIN SELECT RAISE(ABORT,'TASK_RUN_STATUS_INVALID'); END;

CREATE TRIGGER WebhookTriggers_kind_insert BEFORE INSERT ON WebhookTriggers WHEN NOT EXISTS(SELECT 1 FROM TaskTriggers WHERE id=NEW.trigger_id AND type='WEBHOOK') BEGIN SELECT RAISE(ABORT,'TRIGGER_CONFIG_KIND_INVALID'); END;

CREATE TRIGGER WebhookTriggers_kind_update BEFORE UPDATE ON WebhookTriggers WHEN NOT EXISTS(SELECT 1 FROM TaskTriggers WHERE id=NEW.trigger_id AND type='WEBHOOK') BEGIN SELECT RAISE(ABORT,'TRIGGER_CONFIG_KIND_INVALID'); END;

CREATE TRIGGER cron_trigger_fields_insert BEFORE INSERT ON CronTriggers WHEN NEW.misfire_policy NOT IN ('SKIP','FIRE_ONCE') OR length(NEW.expression)<1 OR length(NEW.expression)>255 OR length(NEW.timezone)<1 OR NEW.next_fire_at IS NULL BEGIN SELECT RAISE(ABORT,'CRON_FIELDS_INVALID'); END;

CREATE TRIGGER cron_trigger_fields_update BEFORE UPDATE ON CronTriggers WHEN NEW.misfire_policy NOT IN ('SKIP','FIRE_ONCE') OR length(NEW.expression)<1 OR length(NEW.expression)>255 OR length(NEW.timezone)<1 OR NEW.next_fire_at IS NULL BEGIN SELECT RAISE(ABORT,'CRON_FIELDS_INVALID'); END;

CREATE TRIGGER git_trigger_fields_insert BEFORE INSERT ON GitUpdateTriggers WHEN NEW.mode NOT IN ('ANY_CHANGE','SOURCE_CHANGE','PATH_FILTER') OR NEW.fire_on_initial NOT IN (0,1) OR NOT json_valid(NEW.path_filters) OR json_type(NEW.path_filters)<>'array' BEGIN SELECT RAISE(ABORT,'GIT_TRIGGER_FIELDS_INVALID'); END;

CREATE TRIGGER git_trigger_fields_update BEFORE UPDATE ON GitUpdateTriggers WHEN NEW.mode NOT IN ('ANY_CHANGE','SOURCE_CHANGE','PATH_FILTER') OR NEW.fire_on_initial NOT IN (0,1) OR NOT json_valid(NEW.path_filters) OR json_type(NEW.path_filters)<>'array' BEGIN SELECT RAISE(ABORT,'GIT_TRIGGER_FIELDS_INVALID'); END;

CREATE TRIGGER task_attempt_number_insert BEFORE INSERT ON TaskRunAttempts WHEN NEW.attempt_number<1 OR NEW.duration_ms<0 BEGIN SELECT RAISE(ABORT,'TASK_ATTEMPT_FIELDS_INVALID'); END;

CREATE TRIGGER task_attempt_number_update BEFORE UPDATE ON TaskRunAttempts WHEN NEW.attempt_number<1 OR NEW.duration_ms<0 BEGIN SELECT RAISE(ABORT,'TASK_ATTEMPT_FIELDS_INVALID'); END;

CREATE TRIGGER task_trigger_fields_insert BEFORE INSERT ON TaskTriggers WHEN NEW.type NOT IN ('CRON','WEBHOOK','GIT_UPDATE') OR NEW.origin NOT IN ('USER','DISCOVERY') OR NEW.enabled NOT IN (0,1) OR NEW.version<1 BEGIN SELECT RAISE(ABORT,'TRIGGER_FIELDS_INVALID'); END;

CREATE TRIGGER task_trigger_fields_update BEFORE UPDATE ON TaskTriggers WHEN NEW.type NOT IN ('CRON','WEBHOOK','GIT_UPDATE') OR NEW.origin NOT IN ('USER','DISCOVERY') OR NEW.enabled NOT IN (0,1) OR NEW.version<1 BEGIN SELECT RAISE(ABORT,'TRIGGER_FIELDS_INVALID'); END;

CREATE TRIGGER task_trigger_identity_update BEFORE UPDATE ON TaskTriggers WHEN NEW.task_id IS NOT OLD.task_id OR NEW.type IS NOT OLD.type OR NEW.discovery_key IS NOT OLD.discovery_key OR (OLD.origin='USER' AND NEW.origin<>'USER') BEGIN SELECT RAISE(ABORT,'TRIGGER_IDENTITY_IMMUTABLE'); END;

CREATE TRIGGER webhook_trigger_fields_insert BEFORE INSERT ON WebhookTriggers WHEN length(NEW.secret_hash)<>64 OR NEW.secret_hash GLOB '*[^0-9a-f]*' OR length(NEW.public_id)<>36 BEGIN SELECT RAISE(ABORT,'WEBHOOK_FIELDS_INVALID'); END;

CREATE TRIGGER webhook_trigger_fields_update BEFORE UPDATE ON WebhookTriggers WHEN length(NEW.secret_hash)<>64 OR NEW.secret_hash GLOB '*[^0-9a-f]*' OR length(NEW.public_id)<>36 BEGIN SELECT RAISE(ABORT,'WEBHOOK_FIELDS_INVALID'); END;

CREATE TRIGGER task_run_initial_state BEFORE INSERT ON TaskRuns WHEN NEW.status NOT IN ('QUEUED','SKIPPED') BEGIN SELECT RAISE(ABORT,'TASK_RUN_STATUS_INVALID'); END;
CREATE TRIGGER task_run_owner_insert BEFORE INSERT ON TaskRuns WHEN NEW.task_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM Tasks WHERE id=NEW.task_id AND workspace_id=NEW.workspace_id) BEGIN SELECT RAISE(ABORT,'TASK_IDENTITY_INVALID'); END;
CREATE TRIGGER task_run_source_type_insert BEFORE INSERT ON TaskRuns WHEN EXISTS(SELECT 1 FROM Workspaces WHERE id=NEW.workspace_id AND ((type='LOCAL' AND NEW.expected_git_commit IS NOT NULL) OR (type='GIT' AND NEW.expected_git_commit IS NULL))) BEGIN SELECT RAISE(ABORT,'WORKSPACE_TYPE_INVALID'); END;
CREATE TRIGGER task_run_resolved_source_guard BEFORE UPDATE OF source_snapshot ON TaskRuns WHEN NEW.source_snapshot IS NOT NULL AND (
 NOT COALESCE(json_extract(NEW.source_snapshot,'$.workspace_id')=NEW.workspace_id,0) OR
 NOT COALESCE(json_extract(NEW.source_snapshot,'$.source_generation')=NEW.expected_source_generation,0) OR
 NOT COALESCE(json_extract(NEW.source_snapshot,'$.content_revision')=NEW.expected_content_revision,0) OR
 NOT COALESCE(json_extract(NEW.source_snapshot,'$.task_definition_version')=NEW.expected_task_definition_version,0) OR
 NOT COALESCE(json_extract(NEW.source_snapshot,'$.inventory_hash')=NEW.expected_inventory_hash,0))
BEGIN SELECT RAISE(ABORT,'SOURCE_SUPERSEDED'); END;
CREATE TRIGGER global_env_revision_monotonic BEFORE UPDATE ON GlobalEnvironmentRevision WHEN NEW.singleton_id<>OLD.singleton_id OR NEW.version<=OLD.version BEGIN SELECT RAISE(ABORT,'WORKSPACE_VERSION_CONFLICT'); END;
CREATE TRIGGER global_env_revision_delete BEFORE DELETE ON GlobalEnvironmentRevision BEGIN SELECT RAISE(ABORT,'WORKSPACE_REFERENCED'); END;

CREATE TRIGGER run_terminal_observability AFTER UPDATE OF status ON TaskRuns WHEN OLD.status<>NEW.status AND NEW.status IN ('SUCCESS','FAILED','TIMEOUT','INTERRUPTED','CANCELLED','SKIPPED') BEGIN 
    UPDATE TaskHealthStates SET last_run_id=NEW.id,last_terminal_status=NEW.status,updated_at=CURRENT_TIMESTAMP,
      last_success_at=CASE WHEN NEW.status='SUCCESS' THEN NEW.finished_at ELSE last_success_at END,
      last_failure_at=CASE WHEN NEW.status IN ('FAILED','TIMEOUT','INTERRUPTED') THEN NEW.finished_at ELSE last_failure_at END,
      consecutive_failures=CASE WHEN NEW.status='SUCCESS' THEN 0 WHEN NEW.status IN ('FAILED','TIMEOUT','INTERRUPTED') THEN consecutive_failures+1 ELSE consecutive_failures END,
      health_state=CASE WHEN NEW.status='SUCCESS' THEN 'HEALTHY' WHEN NEW.status IN ('FAILED','TIMEOUT','INTERRUPTED') THEN 'FAILING' ELSE health_state END WHERE task_id=NEW.task_id;
    INSERT INTO NotificationOutbox(event_type,task_id,task_run_id,channel_id,dedupe_key,message)
      SELECT CASE WHEN NEW.status='SUCCESS' AND h.failure_alert_open=1 AND p.notify_recovery=1 THEN 'RECOVERY' ELSE NEW.status END,NEW.task_id,NEW.id,c.id,NEW.id||':'||CASE WHEN NEW.status='SUCCESS' AND h.failure_alert_open=1 AND p.notify_recovery=1 THEN 'RECOVERY' ELSE NEW.status END||':'||c.id,
      json_object('event',CASE WHEN NEW.status='SUCCESS' AND h.failure_alert_open=1 AND p.notify_recovery=1 THEN 'RECOVERY' ELSE NEW.status END,'task',json_object('id',NEW.task_id,'name',t.name),'run',json_object('id',NEW.id,'status',NEW.status,'trigger_type',NEW.trigger_type,'started_at',NEW.started_at,'finished_at',NEW.finished_at,'duration_ms',CASE WHEN NEW.started_at IS NULL THEN NULL ELSE MAX(0,CAST(ROUND((julianday(NEW.finished_at)-julianday(NEW.started_at))*86400000) AS INTEGER)) END,'attempts',NEW.attempt_count,'error_code',NEW.error_code))
      FROM TaskNotificationPolicies p JOIN TaskHealthStates h ON h.task_id=p.task_id JOIN Tasks t ON t.id=p.task_id JOIN NotificationChannels c ON c.enabled=1 AND c.archived=0 AND (p.channel_mode='DEFAULT' AND c.is_default=1 OR p.channel_mode='EXPLICIT' AND EXISTS(SELECT 1 FROM TaskNotificationChannelBindings b WHERE b.task_id=p.task_id AND b.channel_id=c.id))
      WHERE p.task_id=NEW.task_id AND p.enabled=1 AND p.channel_mode<>'NONE' AND (
    (NEW.status='SUCCESS' AND (p.notify_success=1 OR (h.failure_alert_open=1 AND p.notify_recovery=1))) OR
    (NEW.status='CANCELLED' AND p.notify_cancelled=1) OR
    (NEW.status IN ('FAILED','TIMEOUT','INTERRUPTED') AND CASE NEW.status WHEN 'FAILED' THEN p.notify_failure WHEN 'TIMEOUT' THEN p.notify_timeout ELSE p.notify_interrupted END=1 AND h.consecutive_failures>=p.failure_threshold AND (h.failure_alert_open=0 OR (p.repeat_every_failures>0 AND (h.consecutive_failures-p.failure_threshold)%p.repeat_every_failures=0))));
    UPDATE TaskHealthStates SET failure_alert_open=CASE WHEN NEW.status='SUCCESS' THEN 0 WHEN NEW.status IN ('FAILED','TIMEOUT','INTERRUPTED') AND EXISTS(SELECT 1 FROM NotificationOutbox WHERE task_run_id=NEW.id AND event_type IN ('FAILED','TIMEOUT','INTERRUPTED')) THEN 1 ELSE failure_alert_open END WHERE task_id=NEW.task_id;
   END;

CREATE TRIGGER run_terminal_insert_observability AFTER INSERT ON TaskRuns WHEN NEW.status IN ('SUCCESS','FAILED','TIMEOUT','INTERRUPTED','CANCELLED','SKIPPED') BEGIN 
    UPDATE TaskHealthStates SET last_run_id=NEW.id,last_terminal_status=NEW.status,updated_at=CURRENT_TIMESTAMP,
      last_success_at=CASE WHEN NEW.status='SUCCESS' THEN NEW.finished_at ELSE last_success_at END,
      last_failure_at=CASE WHEN NEW.status IN ('FAILED','TIMEOUT','INTERRUPTED') THEN NEW.finished_at ELSE last_failure_at END,
      consecutive_failures=CASE WHEN NEW.status='SUCCESS' THEN 0 WHEN NEW.status IN ('FAILED','TIMEOUT','INTERRUPTED') THEN consecutive_failures+1 ELSE consecutive_failures END,
      health_state=CASE WHEN NEW.status='SUCCESS' THEN 'HEALTHY' WHEN NEW.status IN ('FAILED','TIMEOUT','INTERRUPTED') THEN 'FAILING' ELSE health_state END WHERE task_id=NEW.task_id;
    INSERT INTO NotificationOutbox(event_type,task_id,task_run_id,channel_id,dedupe_key,message)
      SELECT CASE WHEN NEW.status='SUCCESS' AND h.failure_alert_open=1 AND p.notify_recovery=1 THEN 'RECOVERY' ELSE NEW.status END,NEW.task_id,NEW.id,c.id,NEW.id||':'||CASE WHEN NEW.status='SUCCESS' AND h.failure_alert_open=1 AND p.notify_recovery=1 THEN 'RECOVERY' ELSE NEW.status END||':'||c.id,
      json_object('event',CASE WHEN NEW.status='SUCCESS' AND h.failure_alert_open=1 AND p.notify_recovery=1 THEN 'RECOVERY' ELSE NEW.status END,'task',json_object('id',NEW.task_id,'name',t.name),'run',json_object('id',NEW.id,'status',NEW.status,'trigger_type',NEW.trigger_type,'started_at',NEW.started_at,'finished_at',NEW.finished_at,'duration_ms',CASE WHEN NEW.started_at IS NULL THEN NULL ELSE MAX(0,CAST(ROUND((julianday(NEW.finished_at)-julianday(NEW.started_at))*86400000) AS INTEGER)) END,'attempts',NEW.attempt_count,'error_code',NEW.error_code))
      FROM TaskNotificationPolicies p JOIN TaskHealthStates h ON h.task_id=p.task_id JOIN Tasks t ON t.id=p.task_id JOIN NotificationChannels c ON c.enabled=1 AND c.archived=0 AND (p.channel_mode='DEFAULT' AND c.is_default=1 OR p.channel_mode='EXPLICIT' AND EXISTS(SELECT 1 FROM TaskNotificationChannelBindings b WHERE b.task_id=p.task_id AND b.channel_id=c.id))
      WHERE p.task_id=NEW.task_id AND p.enabled=1 AND p.channel_mode<>'NONE' AND (
    (NEW.status='SUCCESS' AND (p.notify_success=1 OR (h.failure_alert_open=1 AND p.notify_recovery=1))) OR
    (NEW.status='CANCELLED' AND p.notify_cancelled=1) OR
    (NEW.status IN ('FAILED','TIMEOUT','INTERRUPTED') AND CASE NEW.status WHEN 'FAILED' THEN p.notify_failure WHEN 'TIMEOUT' THEN p.notify_timeout ELSE p.notify_interrupted END=1 AND h.consecutive_failures>=p.failure_threshold AND (h.failure_alert_open=0 OR (p.repeat_every_failures>0 AND (h.consecutive_failures-p.failure_threshold)%p.repeat_every_failures=0))));
    UPDATE TaskHealthStates SET failure_alert_open=CASE WHEN NEW.status='SUCCESS' THEN 0 WHEN NEW.status IN ('FAILED','TIMEOUT','INTERRUPTED') AND EXISTS(SELECT 1 FROM NotificationOutbox WHERE task_run_id=NEW.id AND event_type IN ('FAILED','TIMEOUT','INTERRUPTED')) THEN 1 ELSE failure_alert_open END WHERE task_id=NEW.task_id;
   END;

CREATE TRIGGER task_run_resolved_source_initial_guard BEFORE INSERT ON TaskRuns WHEN NEW.source_snapshot IS NOT NULL BEGIN SELECT RAISE(ABORT,'SOURCE_SUPERSEDED'); END;
CREATE TRIGGER task_run_live_identity_immutable BEFORE UPDATE OF task_id ON TaskRuns WHEN NEW.task_id IS NOT OLD.task_id AND NOT (NEW.task_id IS NULL AND OLD.status IN ('SUCCESS','FAILED','TIMEOUT','CANCELLED','INTERRUPTED','SKIPPED')) BEGIN SELECT RAISE(ABORT,'TASK_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER task_run_claim_workspace_guard BEFORE UPDATE OF status ON TaskRuns WHEN OLD.status='QUEUED' AND NEW.status='RESOLVING' AND (
 NOT EXISTS(SELECT 1 FROM Workspaces WHERE id=NEW.workspace_id AND lifecycle_state='READY' AND storage_state='PRESENT') OR
 EXISTS(SELECT 1 FROM WorkspaceOperations WHERE workspace_id=NEW.workspace_id AND status IN ('PENDING','RUNNING','DRAINING','RECOVERY_REQUIRED')) OR EXISTS(SELECT 1 FROM WorkspaceSyncRuns WHERE workspace_id=NEW.workspace_id AND status='RECOVERY_REQUIRED'))
BEGIN SELECT RAISE(ABORT,'WORKSPACE_NOT_READY'); END;
CREATE TRIGGER task_run_resolved_source_type_guard BEFORE UPDATE OF source_snapshot ON TaskRuns WHEN NEW.source_snapshot IS NOT NULL AND (
 NOT EXISTS(SELECT 1 FROM Workspaces w WHERE w.id=NEW.workspace_id AND w.type=json_extract(NEW.source_snapshot,'$.workspace_type')) OR
 NOT COALESCE(length(json_extract(NEW.source_snapshot,'$.entrypoint_checksum'))=64 AND json_extract(NEW.source_snapshot,'$.entrypoint_checksum') NOT GLOB '*[^0-9a-f]*',0) OR
 (NEW.expected_git_commit IS NOT NULL AND NOT COALESCE(json_extract(NEW.source_snapshot,'$.git.commit')=NEW.expected_git_commit,0)) OR
 (NEW.expected_git_commit IS NULL AND json_type(NEW.source_snapshot,'$.git') IS NOT 'null'))
BEGIN SELECT RAISE(ABORT,'SOURCE_SUPERSEDED'); END;

-- Safe resource relation for definitions; live filesystem verification still requires the EX lease.
CREATE VIEW ReadyWorkspaceResources AS
 SELECT w.id AS workspace_id,w.name,w.type,w.root_key,w.version,w.source_generation,w.content_revision,w.content_inventory_hash,w.root_device,w.root_inode,w.root_owner_token,w.default_env_profile_id,
 g.repository_id,g.ref_type,g.ref_name,g.private_branch,g.resolved_commit,g.last_verified_commit,g.applied_commit
 FROM Workspaces w LEFT JOIN GitWorkspaces g ON g.workspace_id=w.id
 WHERE w.lifecycle_state='READY' AND w.storage_state='PRESENT'
 AND (w.type='LOCAL' AND g.workspace_id IS NULL OR w.type='GIT' AND g.workspace_id IS NOT NULL AND g.last_verified_commit IS NOT NULL AND g.applied_commit IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM WorkspaceOperations o WHERE o.workspace_id=w.id AND o.status IN ('PENDING','RUNNING','DRAINING','RECOVERY_REQUIRED'))
 AND NOT EXISTS(SELECT 1 FROM WorkspaceSyncRuns r WHERE r.workspace_id=w.id AND r.status='RECOVERY_REQUIRED');

CREATE TRIGGER trigger_event_state_transition BEFORE UPDATE OF status ON TriggerEvents WHEN NEW.status<>OLD.status AND NOT(
 (OLD.status='RECEIVED' AND NEW.status IN ('PROCESSING','SUBMITTED','SKIPPED')) OR
 (OLD.status='PROCESSING' AND NEW.status IN ('SUBMITTED','SKIPPED','FAILED')))
BEGIN SELECT RAISE(ABORT,'TRIGGER_EVENT_INVALID'); END;
CREATE TRIGGER task_run_resolved_source_phase_guard BEFORE UPDATE OF source_snapshot ON TaskRuns WHEN OLD.source_snapshot IS NULL AND NEW.source_snapshot IS NOT NULL AND OLD.status<>'RESOLVING' BEGIN SELECT RAISE(ABORT,'SOURCE_SUPERSEDED'); END;
CREATE TRIGGER task_run_forbid_guard BEFORE INSERT ON TaskRuns WHEN NEW.status='QUEUED' AND NEW.concurrency_policy='FORBID' AND EXISTS(SELECT 1 FROM TaskRuns WHERE task_id=NEW.task_id AND status IN ('QUEUED','RESOLVING','RUNNING','RECOVERY_REQUIRED')) BEGIN SELECT RAISE(ABORT,'TASK_CONCURRENCY_FORBID'); END;

CREATE UNIQUE INDEX workspace_sync_initial_success ON WorkspaceSyncRuns(workspace_id) WHERE initial=1 AND status='SUCCESS';
CREATE TRIGGER sync_run_initial_insert_guard BEFORE INSERT ON WorkspaceSyncRuns WHEN EXISTS(SELECT 1 FROM GitWorkspaces WHERE workspace_id=NEW.workspace_id AND NEW.initial<>(1-baseline_established)) BEGIN SELECT RAISE(ABORT,'SYNC_POLICY_INVALID'); END;
CREATE TRIGGER git_workspace_baseline_guard BEFORE UPDATE OF baseline_established,baseline_sync_run_id ON GitWorkspaces WHEN
 NEW.baseline_established<OLD.baseline_established OR
 (NEW.baseline_established=0 AND NEW.baseline_sync_run_id IS NOT NULL) OR
 (OLD.baseline_established=1 AND NEW.baseline_sync_run_id IS NOT OLD.baseline_sync_run_id AND NEW.baseline_sync_run_id IS NOT NULL) OR
 (OLD.baseline_established=0 AND NEW.baseline_established=1 AND NOT EXISTS(SELECT 1 FROM WorkspaceSyncRuns r JOIN WorkspaceUpdateOutbox o ON o.sync_run_id=r.id WHERE r.id=NEW.baseline_sync_run_id AND r.workspace_id=NEW.workspace_id AND r.initial=1 AND r.status='SUCCESS' AND o.initial=1 AND o.workspace_id=NEW.workspace_id))
BEGIN SELECT RAISE(ABORT,'SYNC_RECOVERY_REQUIRED'); END;

CREATE TRIGGER task_run_retired_admission_guard BEFORE INSERT ON TaskRuns WHEN EXISTS(SELECT 1 FROM Tasks WHERE id=NEW.task_id AND origin='DISCOVERED' AND discovery_state='RETIRED') BEGIN SELECT RAISE(ABORT,'TASK_NOT_READY'); END;
CREATE TRIGGER task_run_retired_claim_guard BEFORE UPDATE OF status ON TaskRuns WHEN OLD.status='QUEUED' AND NEW.status='RESOLVING' AND EXISTS(SELECT 1 FROM Tasks WHERE id=NEW.task_id AND origin='DISCOVERED' AND discovery_state='RETIRED') BEGIN SELECT RAISE(ABORT,'TASK_NOT_READY'); END;


-- Unchanged referenced domain indexes and safety guards.
CREATE UNIQUE INDEX `config_asset_revisions_asset_id_revision_number` ON `ConfigAssetRevisions` (`asset_id`, `revision_number`);

CREATE INDEX `cron_triggers_next_fire_at_trigger_id` ON `CronTriggers` (`next_fire_at`, `trigger_id`);

CREATE INDEX python_environment_builds_runtime ON PythonEnvironmentBuilds(runtime_id);

CREATE INDEX python_environment_revisions_runtime ON PythonEnvironmentRevisions(runtime_id);

CREATE UNIQUE INDEX runtime_installations_provider_id_implementation_version ON RuntimeInstallations(provider_id,implementation,version);

CREATE INDEX runtime_operations_provider_id_status ON RuntimeOperations(provider_id,status);

CREATE UNIQUE INDEX runtime_providers_language_provider_type ON RuntimeProviders (language,provider_type);

CREATE UNIQUE INDEX `task_env_variables_task_id_name` ON `TaskEnvVariables` (`task_id`, `name`);

CREATE UNIQUE INDEX `task_hooks_task_id_phase_position` ON `TaskHooks` (`task_id`, `phase`, `position`);

CREATE UNIQUE INDEX `task_run_attempts_task_run_id_attempt_number` ON `TaskRunAttempts` (`task_run_id`, `attempt_number`);

CREATE INDEX `task_stats_date` ON `TaskStats` (`date`);

CREATE UNIQUE INDEX `task_stats_ref_id_date` ON `TaskStats` (`ref_id`, `date`);

CREATE UNIQUE INDEX `task_triggers_task_id_discovery_key` ON `TaskTriggers` (`task_id`, `discovery_key`);

CREATE INDEX `task_triggers_task_id_type` ON `TaskTriggers` (`task_id`, `type`);

CREATE INDEX task_runs_status_finished ON TaskRuns(status,finished_at,id);

CREATE INDEX task_runs_task_finished ON TaskRuns(task_id,finished_at,id);

CREATE INDEX task_runs_trigger_submitted ON TaskRuns(trigger_type,submitted_at,id);

CREATE INDEX task_runs_finished ON TaskRuns(finished_at,id);

CREATE INDEX notification_outbox_due ON NotificationOutbox(status,next_attempt_at,id);

CREATE INDEX notification_outbox_run ON NotificationOutbox(task_run_id,id);

CREATE TRIGGER node_build_identity_immutable BEFORE UPDATE OF environment_id,revision_id,runtime_id,toolchain_id ON NodeEnvironmentBuilds BEGIN SELECT RAISE(ABORT,'NODE_BUILD_IMMUTABLE'); END;

CREATE TRIGGER node_build_ready_state BEFORE UPDATE OF state ON NodeEnvironmentBuilds WHEN OLD.state='READY' AND NEW.state NOT IN ('READY','DELETING') BEGIN SELECT RAISE(ABORT,'NODE_BUILD_IMMUTABLE'); END;

CREATE TRIGGER node_build_snapshot_immutable BEFORE UPDATE OF package_json,lockfile,lock_hash,resolved,resolved_hash,metadata ON NodeEnvironmentBuilds WHEN OLD.lock_hash IS NOT NULL BEGIN SELECT RAISE(ABORT,'NODE_BUILD_IMMUTABLE'); END;

CREATE TRIGGER node_revision_dependencies_unique BEFORE INSERT ON NodeEnvironmentRevisions WHEN EXISTS(SELECT 1 FROM json_each(NEW.dependencies) GROUP BY json_extract(value,'$.name') HAVING count(*)>1) BEGIN SELECT RAISE(ABORT,'NODE_DEPENDENCY_DUPLICATE'); END;

CREATE TRIGGER node_revision_immutable BEFORE UPDATE ON NodeEnvironmentRevisions BEGIN SELECT RAISE(ABORT,'NODE_REVISION_IMMUTABLE'); END;

CREATE TRIGGER node_toolchain_identity_immutable BEFORE UPDATE OF runtime_id,manager_type,version ON NodePackageManagerToolchains BEGIN SELECT RAISE(ABORT,'NODE_TOOLCHAIN_IMMUTABLE'); END;

CREATE TRIGGER node_toolchain_runtime_insert BEFORE INSERT ON NodePackageManagerToolchains WHEN NOT EXISTS(SELECT 1 FROM RuntimeInstallations WHERE id=NEW.runtime_id AND language='NODE' AND implementation='NODEJS') BEGIN SELECT RAISE(ABORT,'NODE_RUNTIME_REQUIRED'); END;

CREATE TRIGGER python_environment_build_identity_immutable BEFORE UPDATE OF environment_id,revision_id,runtime_id ON PythonEnvironmentBuilds BEGIN SELECT RAISE(ABORT,'PYTHON_ENV_BUILD_IMMUTABLE'); END;

CREATE TRIGGER python_environment_build_ready_immutable BEFORE UPDATE OF resolved,resolved_hash,freeze,metadata ON PythonEnvironmentBuilds WHEN OLD.resolved_hash IS NOT NULL BEGIN SELECT RAISE(ABORT,'PYTHON_ENV_BUILD_IMMUTABLE'); END;

CREATE TRIGGER python_environment_build_ready_state BEFORE UPDATE OF state ON PythonEnvironmentBuilds WHEN OLD.state='READY' AND NEW.state NOT IN ('READY','DELETING') BEGIN SELECT RAISE(ABORT,'PYTHON_ENV_BUILD_IMMUTABLE'); END;

CREATE TRIGGER python_environment_revision_immutable BEFORE UPDATE ON PythonEnvironmentRevisions BEGIN SELECT RAISE(ABORT,'PYTHON_ENV_REVISION_IMMUTABLE'); END;

CREATE TRIGGER runtime_installation_identity_immutable BEFORE UPDATE OF provider_id,language,implementation,version ON RuntimeInstallations BEGIN SELECT RAISE(ABORT,'RUNTIME_IDENTITY_IMMUTABLE'); END;

CREATE TRIGGER runtime_installation_language_insert BEFORE INSERT ON RuntimeInstallations WHEN NOT EXISTS(SELECT 1 FROM RuntimeProviders WHERE id=NEW.provider_id AND language=NEW.language) OR NOT ((NEW.language='PYTHON' AND NEW.implementation='CPYTHON') OR (NEW.language='NODE' AND NEW.implementation='NODEJS')) BEGIN SELECT RAISE(ABORT,'RUNTIME_PROVIDER_INVALID'); END;

CREATE TRIGGER runtime_provider_identity_immutable BEFORE UPDATE OF language,provider_type ON RuntimeProviders BEGIN SELECT RAISE(ABORT,'RUNTIME_IDENTITY_IMMUTABLE'); END;

CREATE TRIGGER runtime_provider_language_pair_insert BEFORE INSERT ON RuntimeProviders WHEN NOT ((NEW.language='PYTHON' AND NEW.provider_type='PYENV') OR (NEW.language='NODE' AND NEW.provider_type='NODE_DISTRIBUTION')) BEGIN SELECT RAISE(ABORT,'RUNTIME_PROVIDER_INVALID'); END;

CREATE TRIGGER task_health_create AFTER INSERT ON Tasks BEGIN INSERT INTO TaskHealthStates(task_id) VALUES(NEW.id); END;

CREATE TRIGGER task_policy_create AFTER INSERT ON TaskExecutionSettings BEGIN INSERT INTO TaskNotificationPolicies(task_id,enabled,notify_success,notify_failure,notify_timeout,notify_interrupted,notify_cancelled,repeat_every_failures) VALUES(NEW.task_id,NEW.notification<>'NONE',NEW.notification IN ('SUCCESS','ALWAYS'),NEW.notification IN ('FAILURE','ALWAYS'),NEW.notification IN ('FAILURE','ALWAYS'),NEW.notification IN ('FAILURE','ALWAYS'),NEW.notification IN ('FAILURE','ALWAYS'),1); END;

CREATE TRIGGER run_submitted_event AFTER INSERT ON TaskRuns BEGIN INSERT INTO TaskRunEvents(task_run_id,sequence,type) VALUES(NEW.id,1,'RUN_SUBMITTED'); INSERT INTO TaskRunEvents(task_run_id,sequence,type) VALUES(NEW.id,2,'RUN_'||NEW.status); END;

CREATE TRIGGER run_status_event AFTER UPDATE OF status ON TaskRuns WHEN OLD.status<>NEW.status BEGIN INSERT INTO TaskRunEvents(task_run_id,sequence,type) SELECT NEW.id,COALESCE(MAX(sequence),0)+1,'RUN_'||NEW.status FROM TaskRunEvents WHERE task_run_id=NEW.id; END;

CREATE TRIGGER run_cancel_event AFTER UPDATE OF cancel_requested ON TaskRuns WHEN OLD.cancel_requested=0 AND NEW.cancel_requested=1 BEGIN INSERT INTO TaskRunEvents(task_run_id,sequence,type) SELECT NEW.id,COALESCE(MAX(sequence),0)+1,'CANCEL_REQUESTED' FROM TaskRunEvents WHERE task_run_id=NEW.id; END;

CREATE TRIGGER attempt_start_event AFTER INSERT ON TaskRunAttempts BEGIN INSERT INTO TaskRunEvents(task_run_id,sequence,type,metadata) SELECT NEW.task_run_id,COALESCE(MAX(sequence),0)+1,'ATTEMPT_STARTED',json_object('attempt',NEW.attempt_number) FROM TaskRunEvents WHERE task_run_id=NEW.task_run_id; END;

-- Precomputed normalized object signature, independently recomputed by validator before acceptance.
INSERT INTO PlatformMetadata(schema_identity,schema_version,model_contract,schema_signature,initialized_at) VALUES('zhixu.workspace.v2.s0.1',1,'S0-2026-11-13','f466bedcecdad199bfb3ca501800f7fac026300d5fc2ad91ea77038cc782fe4c',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
COMMIT;
