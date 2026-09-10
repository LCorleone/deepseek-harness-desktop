---
name: fixture-hello
description: Fixture skill for the company-skills packer and verifier tests.
---

# Fixture hello

This fixture exists only so the packer tests have a real skill directory: one
body, one script, one asset, and at least one script-to-asset reference the
reference gate can resolve.

Run `scripts/hello.mjs` to print the notes, which live in `assets/notes.md`.
