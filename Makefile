.PHONY: up down logs reset-labs clean dev build test test-unit test-integration test-e2e typecheck lint coverage-matrix

## Docker (production-style)
up:
	docker compose up --build

down:
	docker compose down

logs:
	docker compose logs -f

## Full cleanup: stop containers AND delete all local data (accounts, progress, XP)
clean:
	docker compose down -v

## Reset just the lab database (accounts/progress) without touching containers
reset-labs:
	npm run db:reset

## Local development (no Docker)
dev:
	npm run dev

build:
	npm run build

test:
	npm run test

test-unit:
	npm run test:unit

test-integration:
	npm run test:integration

test-e2e:
	npm run test:e2e

typecheck:
	npm run typecheck

lint:
	npm run lint

coverage-matrix:
	npm run coverage:matrix
