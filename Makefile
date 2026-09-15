# ==========================================
# CointMU CLI (cmu-cli)
# ==========================================

VERSION = 1
PATCHLEVEL = 3
SUBLEVEL = 5
CODENAME = Cerberus
BUILD = 91b6de0c

.PHONY: help dev build install-global clean

help:
	@echo "=========================================="
	@echo "  CointMU CLI Makefile Help               "
	@echo "=========================================="
	@echo "  dev            - Start TS compiler in watch mode"
	@echo "  build          - Build TypeScript source code"
	@echo "  install-global - Link package globally for local testing"
	@echo "  clean          - Clean build artifacts"
	@echo "  help           - Print this help message"
	@echo "=========================================="

dev:
	npm run watch

build:
	npm run build

install-global:
	npm install -g .

clean:
	rm -rf dist build