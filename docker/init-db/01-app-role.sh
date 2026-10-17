#!/bin/bash
# Local-dev only: give the least-privilege `app` role a login password so
# APP_DATABASE_URL works out of the box. Production sets its own strong
# password via APP_DB_PASSWORD (or creates the role manually).
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	DO \$\$ BEGIN
		IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app') THEN
			CREATE ROLE app LOGIN PASSWORD '${APP_DB_PASSWORD:-app}';
		ELSE
			ALTER ROLE app WITH LOGIN PASSWORD '${APP_DB_PASSWORD:-app}';
		END IF;
	END \$\$;
EOSQL
